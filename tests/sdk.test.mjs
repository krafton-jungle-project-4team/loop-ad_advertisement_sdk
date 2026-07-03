import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as sdkModule from "../dist/index.mjs";

const { init, version } = sdkModule;

let requests;
let target;
let assignedUrls;
let observers;
let client;

beforeEach(() => {
    requests = [];
    assignedUrls = [];
    observers = [];
    client = null;

    setGlobal("window", {
        location: {
            assign(url) {
                assignedUrls.push(url);
            }
        }
    });
    setGlobal("document", createDocument());
    setGlobal("IntersectionObserver", FakeIntersectionObserver);
    setGlobal("fetch", async (url, options = {}) => {
        requests.push({
            url,
            method: options.method,
            credentials: options.credentials,
            headers: options.headers
        });

        return {
            ok: true,
            status: 200,
            async json() {
                return envelope(filledDecision());
            }
        };
    });

    target = document.createTarget("loopad-main-banner");
});

afterEach(() => {
    client?.destroy();
    delete globalThis.IntersectionObserver;
});

test("exports init and unwraps the banner resolve API envelope", async () => {
    assert.equal(typeof init, "function");
    assert.equal(typeof version, "string");

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api/",
        projectId: "project-1",
        userId: "user-123",
        promotionRunId: "run-1"
    });

    const decision = await client.render({
        placementId: "hero",
        targetId: "loopad-main-banner"
    });

    const requestUrl = new URL(requests[0].url);
    assert.equal(requestUrl.origin, "https://dashboard.api.dev.loop-ad.org");
    assert.equal(requestUrl.pathname, "/api/ad/banner/resolve");
    assert.equal(requestUrl.searchParams.get("project_id"), "project-1");
    assert.equal(requestUrl.searchParams.get("promotion_run_id"), "run-1");
    assert.equal(requestUrl.searchParams.get("user_id"), "user-123");
    assert.equal(requestUrl.searchParams.get("placement_id"), "hero");
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].credentials, "omit");
    assert.equal(decision.status, "filled");
    assert.equal(decision.placementId, "hero");
    assert.equal(decision.tracking.content_id, "content-1");
});

test("keeps placementKey as a compatibility alias for placementId", async () => {
    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "project-1",
        userId: "user-123",
        promotionRunId: "run-1"
    });

    await client.render({
        placementKey: "hero",
        targetId: "loopad-main-banner"
    });

    const requestUrl = new URL(requests[0].url);
    assert.equal(requestUrl.searchParams.get("placement_id"), "hero");
});

test("handles missing banner assignments by clearing the target without callbacks", async () => {
    target.appendChild(new FakeElement("span"));
    let impressions = 0;

    globalThis.fetch = async () => ({
        ok: false,
        status: 404,
        async json() {
            return errorEnvelope("BANNER_ASSIGNMENT_NOT_FOUND");
        }
    });

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "project-1",
        userId: "user-123",
        promotionRunId: "run-1"
    });

    const decision = await client.render({
        placementId: "sidebar",
        targetId: "loopad-main-banner",
        onImpression() {
            impressions += 1;
        }
    });

    assert.equal(decision.status, "empty");
    assert.equal(decision.placementId, "sidebar");
    assert.equal(target.children.length, 0);
    assert.equal(impressions, 0);
});

test("renders minimal DOM nodes with tracking data attributes", async () => {
    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "project-1",
        userId: "user-123",
        promotionRunId: "run-1"
    });

    await client.render({
        placementId: "hero",
        targetId: "loopad-main-banner"
    });

    const anchor = target.children[0];
    assert.equal(anchor.tagName, "A");
    assert.equal(anchor.className, "loopad-ad-link");
    assert.equal(anchor.getAttribute("data-loopad-placement-id"), "hero");
    assert.equal(anchor.getAttribute("data-loopad-project-id"), "project-1");
    assert.equal(anchor.getAttribute("data-loopad-user-id"), "user-123");
    assert.equal(anchor.getAttribute("data-loopad-campaign-id"), "campaign-1");
    assert.equal(anchor.getAttribute("data-loopad-promotion-id"), "promotion-1");
    assert.equal(anchor.getAttribute("data-loopad-promotion-run-id"), "run-1");
    assert.equal(anchor.getAttribute("data-loopad-ad-experiment-id"), "exp-1");
    assert.equal(anchor.getAttribute("data-loopad-segment-id"), "seg-1");
    assert.equal(anchor.getAttribute("data-loopad-content-id"), "content-1");
    assert.equal(anchor.getAttribute("data-loopad-content-option-id"), "option-1");
    assert.equal(anchor.getAttribute("data-loopad-promotion-channel"), "onsite_banner");
    assert.deepEqual(
        anchor.children.map((child) => child.className),
        ["loopad-ad-title", "loopad-ad-body", "loopad-ad-cta"]
    );
    assert.equal(anchor.children[0].textContent, "Summer sale");
    assert.equal(anchor.children[1].textContent, "Save today");
    assert.equal(anchor.children[2].textContent, "Shop now");
});

test("fires impression once after at least half the ad is visible", async () => {
    const impressions = [];

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "project-1",
        userId: "user-123",
        promotionRunId: "run-1"
    });

    await client.render({
        placementId: "hero",
        targetId: "loopad-main-banner",
        onImpression(decision) {
            impressions.push(decision.tracking);
        }
    });

    assert.equal(impressions.length, 0);
    observers[0].trigger(0.49);
    assert.equal(impressions.length, 0);
    observers[0].trigger(0.5);
    observers[0].trigger(1);
    assert.equal(impressions.length, 1);
    assert.equal(impressions[0].content_id, "content-1");
});

test("falls back to one immediate impression when IntersectionObserver is unavailable", async () => {
    delete globalThis.IntersectionObserver;
    let impressions = 0;

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "project-1",
        userId: "user-123",
        promotionRunId: "run-1"
    });

    await client.render({
        placementId: "hero",
        targetId: "loopad-main-banner",
        onImpression() {
            impressions += 1;
        }
    });

    assert.equal(impressions, 1);
});

test("calls click callback before assigning the target URL", async () => {
    const clicks = [];

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "project-1",
        userId: "user-123",
        promotionRunId: "run-1"
    });

    await client.render({
        placementId: "hero",
        targetId: "loopad-main-banner",
        onClick(decision) {
            clicks.push({
                contentId: decision.tracking.content_id,
                assignedCount: assignedUrls.length
            });
        }
    });

    target.children[0].dispatch("click", { preventDefault() {} });

    assert.deepEqual(clicks, [{ contentId: "content-1", assignedCount: 0 }]);
    assert.deepEqual(assignedUrls, ["https://demo-shop.loop-ad.org/sale"]);
});

function envelope(data) {
    return {
        requestId: "req-1",
        data
    };
}

function errorEnvelope(code) {
    return {
        requestId: "req-1",
        error: {
            statusCode: 404,
            code,
            message: "No active onsite banner assignment was found."
        }
    };
}

function filledDecision() {
    return {
        project_id: "project-1",
        user_id: "user-123",
        campaign_id: "campaign-1",
        promotion_id: "promotion-1",
        promotion_run_id: "run-1",
        ad_experiment_id: "exp-1",
        segment_id: "seg-1",
        content_id: "content-1",
        content_option_id: "option-1",
        promotion_channel: "onsite_banner",
        placement_id: "hero",
        title: "Summer sale",
        body: "Save today",
        cta: "Shop now",
        target_url: "https://demo-shop.loop-ad.org/sale"
    };
}

function createDocument() {
    const elements = new Map();

    return {
        createElement(tagName) {
            return new FakeElement(tagName);
        },
        getElementById(id) {
            return elements.get(id) ?? null;
        },
        createTarget(id) {
            const element = new FakeElement("div");
            element.id = id;
            elements.set(id, element);
            return element;
        }
    };
}

function setGlobal(name, value) {
    Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value
    });
}

class FakeIntersectionObserver {
    constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.observed = [];
        this.disconnected = false;
        observers.push(this);
    }

    observe(element) {
        this.observed.push(element);
    }

    disconnect() {
        this.disconnected = true;
    }

    trigger(ratio) {
        this.callback([
            {
                isIntersecting: ratio > 0,
                intersectionRatio: ratio
            }
        ]);
    }
}

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.textContent = "";
        this.className = "";
        this.id = "";
        this.href = "";
        this.src = "";
        this.alt = "";
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    replaceChildren(...children) {
        this.children = children;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type).add(handler);
    }

    dispatch(type, event = {}) {
        for (const handler of this.listeners.get(type) ?? []) {
            handler(event);
        }
    }
}
