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

    setGlobal("location", {
        href: "https://demo-shop.loop-ad.org/",
        pathname: "/"
    });
    setGlobal("navigator", {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)"
    });
    setGlobal("window", {
        location: {
            assign(url) {
                assignedUrls.push(url);
            }
        }
    });
    setGlobal("document", createDocument());
    setGlobal("IntersectionObserver", FakeIntersectionObserver);
    setGlobal("fetch", async (url, options) => {
        requests.push({
            url,
            method: options.method,
            credentials: options.credentials,
            body: JSON.parse(options.body)
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

test("exports init and unwraps the API envelope", async () => {
    assert.equal(typeof init, "function");
    assert.equal(typeof version, "string");

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api/",
        projectId: "demo-shop",
        userId: "user-123"
    });

    const decision = await client.render({
        placementKey: "C1_MAIN_TOP",
        targetId: "loopad-main-banner"
    });

    assert.equal(requests[0].url, "https://dashboard.api.dev.loop-ad.org/api/ads/serve");
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].credentials, "omit");
    assert.equal(requests[0].body.projectId, "demo-shop");
    assert.equal(requests[0].body.userId, "user-123");
    assert.equal(requests[0].body.placementKey, "C1_MAIN_TOP");
    assert.equal(requests[0].body.context.pageUrl, "/");
    assert.equal(requests[0].body.context.device, "desktop");
    assert.equal(decision.status, "filled");
    assert.equal(decision.tracking.mappingId, "501");
});

test("handles empty decisions by clearing the target without callbacks", async () => {
    target.appendChild(new FakeElement("span"));
    let impressions = 0;

    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
            return envelope({
                placementKey: "W1_WING",
                status: "empty",
                ad: null,
                tracking: null
            });
        }
    });

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "demo-shop",
        userId: "user-123"
    });

    const decision = await client.render({
        placementKey: "W1_WING",
        targetId: "loopad-main-banner",
        onImpression() {
            impressions += 1;
        }
    });

    assert.equal(decision.status, "empty");
    assert.equal(target.children.length, 0);
    assert.equal(impressions, 0);
});

test("renders minimal DOM nodes with tracking data attributes", async () => {
    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "demo-shop",
        userId: "user-123"
    });

    await client.render({
        placementKey: "C1_MAIN_TOP",
        targetId: "loopad-main-banner"
    });

    const anchor = target.children[0];
    assert.equal(anchor.tagName, "A");
    assert.equal(anchor.className, "loopad-ad-link");
    assert.equal(anchor.getAttribute("data-loopad-placement-key"), "C1_MAIN_TOP");
    assert.equal(anchor.getAttribute("data-loopad-project-id"), "demo-shop");
    assert.equal(anchor.getAttribute("data-loopad-experiment-id"), "42");
    assert.equal(anchor.getAttribute("data-loopad-variant-id"), "11");
    assert.equal(anchor.getAttribute("data-loopad-creative-id"), "101");
    assert.equal(anchor.getAttribute("data-loopad-mapping-id"), "501");
    assert.equal(anchor.getAttribute("data-loopad-action-id"), "7");
    assert.deepEqual(
        anchor.children.map((child) => child.className),
        ["loopad-ad-image", "loopad-ad-title", "loopad-ad-body", "loopad-ad-cta"]
    );
    assert.equal(anchor.children[1].textContent, "Summer sale");
    assert.equal(anchor.children[2].textContent, "Save today");
    assert.equal(anchor.children[3].textContent, "Shop now");
});

test("fires impression once after at least half the ad is visible", async () => {
    const impressions = [];

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "demo-shop",
        userId: "user-123"
    });

    await client.render({
        placementKey: "C1_MAIN_TOP",
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
    assert.equal(impressions[0].mappingId, "501");
});

test("falls back to one immediate impression when IntersectionObserver is unavailable", async () => {
    delete globalThis.IntersectionObserver;
    let impressions = 0;

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "demo-shop",
        userId: "user-123"
    });

    await client.render({
        placementKey: "C1_MAIN_TOP",
        targetId: "loopad-main-banner",
        onImpression() {
            impressions += 1;
        }
    });

    assert.equal(impressions, 1);
});

test("calls click callback before assigning the landing URL", async () => {
    const clicks = [];

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "demo-shop",
        userId: "user-123"
    });

    await client.render({
        placementKey: "C1_MAIN_TOP",
        targetId: "loopad-main-banner",
        onClick(decision) {
            clicks.push({
                mappingId: decision.tracking.mappingId,
                assignedCount: assignedUrls.length
            });
        }
    });

    target.children[0].dispatch("click", { preventDefault() {} });

    assert.deepEqual(clicks, [{ mappingId: "501", assignedCount: 0 }]);
    assert.deepEqual(assignedUrls, ["https://demo-shop.loop-ad.org/sale"]);
});

function envelope(data) {
    return {
        requestId: "req-1",
        data
    };
}

function filledDecision() {
    return {
        placementKey: "C1_MAIN_TOP",
        status: "filled",
        ad: {
            creativeId: "101",
            contentType: "banner",
            title: "Summer sale",
            body: "Save today",
            ctaLabel: "Shop now",
            imageUrl: "https://cdn.loop-ad.org/banner.png",
            landingUrl: "https://demo-shop.loop-ad.org/sale"
        },
        tracking: {
            projectId: "demo-shop",
            experimentId: "42",
            variantId: "11",
            creativeId: "101",
            mappingId: "501",
            actionId: "7"
        }
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
