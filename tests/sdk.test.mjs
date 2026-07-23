import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as sdkModule from "../dist/index.mjs";

const { init, version } = sdkModule;

let requests;
let target;
let assignedUrls;
let observers;
let windowListeners;
let client;

beforeEach(() => {
    requests = [];
    assignedUrls = [];
    observers = [];
    windowListeners = new Map();
    client = null;

    setGlobal("window", createWindow());
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

test("exports init and requests the banner resolve contract endpoint", async () => {
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
    assert.equal(decision.creative.creative_format, "banner_html");
    assert.equal(decision.attribution.creative_id, "content-1");
});

test("uses the explicit pseudonymous subject contract without user_id", async () => {
    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api/",
        projectId: "project-1",
        subjectId:
            "sub_15d6d4bda1882ae636a857db0c4932223a8d321d8020374cf9edcbb71f5e2963",
        promotionRunId: "run-1"
    });

    await client.render({
        placementId: "hero",
        targetId: "loopad-main-banner"
    });

    const requestUrl = new URL(requests[0].url);
    assert.equal(requestUrl.searchParams.get("user_id"), null);
    assert.equal(
        requestUrl.searchParams.get("subject_id"),
        "sub_15d6d4bda1882ae636a857db0c4932223a8d321d8020374cf9edcbb71f5e2963"
    );
});

test("rejects ambiguous advertisement identities", () => {
    assert.throws(
        () =>
            init({
                apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api/",
                projectId: "project-1",
                userId: "user-123",
                subjectId:
                    "sub_15d6d4bda1882ae636a857db0c4932223a8d321d8020374cf9edcbb71f5e2963",
                promotionRunId: "run-1"
            }),
        /exactly one of userId or subjectId/
    );
});

test("handles empty resolve responses by clearing the target without callbacks", async () => {
    target.appendChild(new FakeElement("span"));
    let loaded = 0;
    let viewable = 0;
    let clicks = 0;

    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
            return envelope({
                status: "empty",
                placement_id: "sidebar",
                reason: "artifact_not_ready"
            });
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
        on_loaded() {
            loaded += 1;
        },
        on_viewable() {
            viewable += 1;
        },
        on_click() {
            clicks += 1;
        }
    });

    assert.equal(decision.status, "empty");
    assert.equal(decision.placementId, "sidebar");
    assert.equal(decision.reason, "artifact_not_ready");
    assert.equal(target.children.length, 0);
    assert.equal(loaded, 0);
    assert.equal(viewable, 0);
    assert.equal(clicks, 0);
});

test("renders a sandboxed iframe for filled responses", async () => {
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

    const iframe = target.children[0];
    assert.equal(iframe.tagName, "IFRAME");
    assert.equal(iframe.className, "loopad-ad-frame");
    assert.equal(iframe.src, "https://gen-ai.asset.dev.loop-ad.org/generated/content-1.banner_html.html");
    assert.equal(iframe.width, "320");
    assert.equal(iframe.height, "100");
    assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
    assert.equal(iframe.getAttribute("data-loopad-placement-id"), "hero");
    assert.equal(iframe.getAttribute("data-loopad-project-id"), "project-1");
    assert.equal(iframe.getAttribute("data-loopad-campaign-id"), "campaign-1");
    assert.equal(iframe.getAttribute("data-loopad-promotion-run-id"), "run-1");
    assert.equal(iframe.getAttribute("data-loopad-ad-experiment-id"), "exp-1");
    assert.equal(iframe.getAttribute("data-loopad-content-id"), "content-1");
    assert.equal(iframe.getAttribute("data-loopad-creative-id"), "content-1");
    assert.equal(iframe.getAttribute("data-loopad-channel"), "onsite_banner");
});

test("fires loaded and viewable callbacks with attribution", async () => {
    const loaded = [];
    const viewable = [];

    client = init({
        apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
        projectId: "project-1",
        userId: "user-123",
        promotionRunId: "run-1"
    });

    await client.render({
        placementId: "hero",
        targetId: "loopad-main-banner",
        on_loaded(event) {
            loaded.push(event.attribution);
        },
        on_viewable(event) {
            viewable.push(event.attribution);
        }
    });

    target.children[0].dispatch("load");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].content_id, "content-1");

    observers[0].trigger(0.49);
    await delay(1050);
    assert.equal(viewable.length, 0);
    observers[0].trigger(0.5);
    await delay(1050);
    observers[0].trigger(1);
    assert.equal(viewable.length, 1);
    assert.equal(viewable[0].creative_id, "content-1");
});

test("handles loopad click postMessage before assigning click_url", async () => {
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
        on_click(event) {
            clicks.push({
                contentId: event.attribution.content_id,
                clickUrl: event.click_url,
                assignedCount: assignedUrls.length
            });
        }
    });

    window.dispatchMessage({ type: "loopad:click" });

    assert.deepEqual(clicks, [
        {
            contentId: "content-1",
            clickUrl:
                "https://demo-shop.loop-ad.org/sale?loopad_project_id=project-1&loopad_channel=onsite_banner",
            assignedCount: 0
        }
    ]);
    assert.deepEqual(assignedUrls, [
        "https://demo-shop.loop-ad.org/sale?loopad_project_id=project-1&loopad_channel=onsite_banner"
    ]);
});

function envelope(data) {
    return {
        requestId: "req-1",
        data
    };
}

function filledDecision() {
    return {
        status: "filled",
        placement_id: "hero",
        creative: {
            creative_id: "content-1",
            creative_format: "banner_html",
            html_url: "https://gen-ai.asset.dev.loop-ad.org/generated/content-1.banner_html.html",
            width: 320,
            height: 100,
            click_url:
                "https://demo-shop.loop-ad.org/sale?loopad_project_id=project-1&loopad_channel=onsite_banner",
            target_url: "https://demo-shop.loop-ad.org/sale",
            sandbox: {
                allow_scripts: true,
                allow_same_origin: false,
                allow_popups: false
            }
        },
        attribution: {
            project_id: "project-1",
            campaign_id: "campaign-1",
            promotion_id: "promotion-1",
            promotion_run_id: "run-1",
            ad_experiment_id: "exp-1",
            segment_id: "seg-1",
            content_id: "content-1",
            content_option_id: "option-1",
            creative_id: "content-1",
            promotion_channel: "onsite_banner",
            target_url: "https://demo-shop.loop-ad.org/sale",
            placement_id: "hero"
        }
    };
}

function createWindow() {
    return {
        location: {
            assign(url) {
                assignedUrls.push(url);
            }
        },
        addEventListener(type, handler) {
            if (!windowListeners.has(type)) {
                windowListeners.set(type, new Set());
            }
            windowListeners.get(type).add(handler);
        },
        removeEventListener(type, handler) {
            windowListeners.get(type)?.delete(handler);
        },
        dispatchMessage(data) {
            for (const handler of windowListeners.get("message") ?? []) {
                handler({ data });
            }
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

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        this.width = "";
        this.height = "";
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

    removeEventListener(type, handler) {
        this.listeners.get(type)?.delete(handler);
    }

    dispatch(type, event = {}) {
        for (const handler of this.listeners.get(type) ?? []) {
            handler(event);
        }
    }
}
