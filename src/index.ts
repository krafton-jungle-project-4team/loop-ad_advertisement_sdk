export interface InitOptions {
    apiBaseUrl: string;
    projectId: string;
    userId: string;
    debug?: boolean | null;
}

export interface RenderContext {
    pageUrl?: string | null;
    device?: string | null;
    [key: string]: string | number | boolean | null | undefined;
}

export interface RenderOptions {
    placementKey: string;
    targetId: string;
    context?: RenderContext | null;
    onImpression?: ((decision: AdvertisementFilledDecision) => void) | null;
    onClick?: ((decision: AdvertisementFilledDecision) => void) | null;
}

export interface AdvertisementClient {
    render(options: RenderOptions): Promise<AdvertisementDecision>;
    destroy(): void;
}

export interface ServedAdCreative {
    creativeId: string;
    contentType: string;
    title: string;
    body: string;
    ctaLabel: string;
    imageUrl: string;
    landingUrl: string;
}

export interface ServedAdTracking {
    projectId: string;
    experimentId: string;
    variantId: string;
    creativeId: string;
    mappingId: string;
    actionId: string;
}

export interface AdvertisementFilledDecision {
    placementKey: string;
    status: "filled";
    ad: ServedAdCreative;
    tracking: ServedAdTracking;
}

export interface AdvertisementEmptyDecision {
    placementKey: string;
    status: "empty";
    ad: null;
    tracking: null;
}

export type AdvertisementDecision = AdvertisementFilledDecision | AdvertisementEmptyDecision;

export const version =
    typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.1.0";

declare const __SDK_VERSION__: string | undefined;

export function init(options: InitOptions): AdvertisementClient {
    return new Runtime(normalizeInitOptions(options)).client;
}

class Runtime {
    readonly client: AdvertisementClient = Object.freeze({
        render: (options: RenderOptions) => this.render(options),
        destroy: () => this.destroy()
    });

    private readonly cleanups = new Map<string, () => void>();

    constructor(private readonly config: NormalizedInitOptions) {}

    private async render(options: RenderOptions): Promise<AdvertisementDecision> {
        const renderOptions = normalizeRenderOptions(options);
        const target = targetElement(renderOptions.targetId);
        const decision = await this.fetchDecision(renderOptions);

        this.clearTarget(renderOptions.targetId, target);

        if (decision.status === "empty") {
            return decision;
        }

        const anchor = createAdAnchor(decision, renderOptions);
        target.appendChild(anchor);

        const cleanup = observeImpression(anchor, decision, renderOptions.onImpression);
        this.cleanups.set(renderOptions.targetId, cleanup);

        return decision;
    }

    private async fetchDecision(options: NormalizedRenderOptions): Promise<AdvertisementDecision> {
        if (typeof fetch !== "function") {
            throw new Error("LoopAdAdvertisementSDK requires fetch.");
        }

        const response = await fetch(`${this.config.apiBaseUrl}/ads/serve`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            credentials: "omit",
            body: JSON.stringify({
                projectId: this.config.projectId,
                userId: this.config.userId,
                placementKey: options.placementKey,
                context: requestContext(options.context)
            })
        });

        if (!response.ok) {
            throw new Error(`LoopAdAdvertisementSDK ad request failed with ${response.status}.`);
        }

        return unwrapEnvelope(await response.json());
    }

    private clearTarget(targetId: string, target: HTMLElement): void {
        this.cleanups.get(targetId)?.();
        this.cleanups.delete(targetId);
        target.replaceChildren();
    }

    private destroy(): void {
        for (const cleanup of this.cleanups.values()) {
            cleanup();
        }

        this.cleanups.clear();
    }
}

interface NormalizedInitOptions {
    apiBaseUrl: string;
    projectId: string;
    userId: string;
    debug: boolean;
}

interface NormalizedRenderOptions {
    placementKey: string;
    targetId: string;
    context: RenderContext;
    onImpression: ((decision: AdvertisementFilledDecision) => void) | null;
    onClick: ((decision: AdvertisementFilledDecision) => void) | null;
}

function normalizeInitOptions(options: InitOptions): NormalizedInitOptions {
    const apiBaseUrl = trimTrailingSlash(requiredText(options?.apiBaseUrl, "apiBaseUrl"));
    const projectId = requiredText(options?.projectId, "projectId");
    const userId = requiredText(options?.userId, "userId");

    return {
        apiBaseUrl,
        projectId,
        userId,
        debug: options.debug ?? false
    };
}

function normalizeRenderOptions(options: RenderOptions): NormalizedRenderOptions {
    return {
        placementKey: requiredText(options?.placementKey, "placementKey"),
        targetId: requiredText(options?.targetId, "targetId"),
        context: cleanContext(options.context ?? {}),
        onImpression: options.onImpression ?? null,
        onClick: options.onClick ?? null
    };
}

function targetElement(targetId: string): HTMLElement {
    if (typeof document === "undefined") {
        throw new Error("LoopAdAdvertisementSDK requires document.");
    }

    const target = document.getElementById(targetId);

    if (!target) {
        throw new Error(`LoopAdAdvertisementSDK target '${targetId}' was not found.`);
    }

    return target;
}

function createAdAnchor(
    decision: AdvertisementFilledDecision,
    options: NormalizedRenderOptions
): HTMLAnchorElement {
    const anchor = document.createElement("a");
    anchor.className = "loopad-ad-link";
    anchor.href = decision.ad.landingUrl || "#";
    anchor.setAttribute("aria-label", decision.ad.title);
    applyTrackingAttributes(anchor, decision);

    const image = document.createElement("img");
    image.className = "loopad-ad-image";
    image.alt = decision.ad.title;
    if (decision.ad.imageUrl) {
        image.src = decision.ad.imageUrl;
    }

    const title = document.createElement("strong");
    title.className = "loopad-ad-title";
    title.textContent = decision.ad.title;

    const body = document.createElement("span");
    body.className = "loopad-ad-body";
    body.textContent = decision.ad.body;

    const cta = document.createElement("span");
    cta.className = "loopad-ad-cta";
    cta.textContent = decision.ad.ctaLabel;

    anchor.appendChild(image);
    anchor.appendChild(title);
    anchor.appendChild(body);
    anchor.appendChild(cta);

    anchor.addEventListener("click", (event) => {
        event.preventDefault();
        options.onClick?.(decision);

        if (decision.ad.landingUrl && typeof window !== "undefined") {
            window.location.assign(decision.ad.landingUrl);
        }
    });

    return anchor;
}

function applyTrackingAttributes(
    anchor: HTMLAnchorElement,
    decision: AdvertisementFilledDecision
): void {
    const attributes = {
        "data-loopad-placement-key": decision.placementKey,
        "data-loopad-project-id": decision.tracking.projectId,
        "data-loopad-experiment-id": decision.tracking.experimentId,
        "data-loopad-variant-id": decision.tracking.variantId,
        "data-loopad-creative-id": decision.tracking.creativeId,
        "data-loopad-mapping-id": decision.tracking.mappingId,
        "data-loopad-action-id": decision.tracking.actionId
    };

    for (const [name, value] of Object.entries(attributes)) {
        anchor.setAttribute(name, value);
    }
}

function observeImpression(
    element: HTMLElement,
    decision: AdvertisementFilledDecision,
    callback: ((decision: AdvertisementFilledDecision) => void) | null
): () => void {
    if (!callback) {
        return noop;
    }

    let fired = false;
    let observer: IntersectionObserver | null = null;
    const fire = () => {
        if (fired) {
            return;
        }

        fired = true;
        callback(decision);
        observer?.disconnect();
    };

    if (typeof IntersectionObserver !== "function") {
        fire();
        return noop;
    }

    observer = new IntersectionObserver(
        (entries) => {
            if (
                entries.some(
                    (entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5
                )
            ) {
                fire();
            }
        },
        { threshold: [0.5] }
    );
    observer.observe(element);

    return () => observer?.disconnect();
}

function unwrapEnvelope(value: unknown): AdvertisementDecision {
    if (!isRecord(value) || !("data" in value)) {
        throw new Error("LoopAdAdvertisementSDK received an invalid API envelope.");
    }

    return normalizeDecision(value.data);
}

function normalizeDecision(value: unknown): AdvertisementDecision {
    if (!isRecord(value)) {
        throw new Error("LoopAdAdvertisementSDK received an invalid ad decision.");
    }

    const placementKey = requiredText(value.placementKey, "placementKey");
    const status = requiredText(value.status, "status");

    if (status === "empty") {
        return {
            placementKey,
            status,
            ad: null,
            tracking: null
        };
    }

    if (status !== "filled") {
        throw new Error(`LoopAdAdvertisementSDK received unsupported status '${status}'.`);
    }

    return {
        placementKey,
        status,
        ad: normalizeCreative(value.ad),
        tracking: normalizeTracking(value.tracking)
    };
}

function normalizeCreative(value: unknown): ServedAdCreative {
    if (!isRecord(value)) {
        throw new Error("LoopAdAdvertisementSDK received an invalid creative.");
    }

    return {
        creativeId: requiredText(value.creativeId, "creativeId"),
        contentType: requiredText(value.contentType, "contentType"),
        title: requiredText(value.title, "title"),
        body: optionalText(value.body),
        ctaLabel: optionalText(value.ctaLabel),
        imageUrl: optionalText(value.imageUrl),
        landingUrl: optionalText(value.landingUrl)
    };
}

function normalizeTracking(value: unknown): ServedAdTracking {
    if (!isRecord(value)) {
        throw new Error("LoopAdAdvertisementSDK received invalid tracking.");
    }

    return {
        projectId: requiredText(value.projectId, "projectId"),
        experimentId: optionalText(value.experimentId),
        variantId: optionalText(value.variantId),
        creativeId: optionalText(value.creativeId),
        mappingId: optionalText(value.mappingId),
        actionId: optionalText(value.actionId)
    };
}

function requestContext(context: RenderContext): RenderContext {
    return {
        pageUrl: currentPageUrl(),
        device: detectDevice(),
        ...context
    };
}

function cleanContext(context: RenderContext): RenderContext {
    return Object.fromEntries(
        Object.entries(context).filter((entry): entry is [string, string | number | boolean | null] => {
            const value = entry[1];

            return (
                value === null ||
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean"
            );
        })
    );
}

function currentPageUrl(): string {
    if (typeof location === "undefined") {
        return "";
    }

    return location.pathname || location.href || "";
}

function detectDevice(): string {
    if (typeof navigator === "undefined") {
        return "";
    }

    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "mobile" : "desktop";
}

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

function requiredText(value: unknown, field: string): string {
    const normalized = optionalText(value);

    if (!normalized) {
        throw new Error(`LoopAdAdvertisementSDK requires ${field}.`);
    }

    return normalized;
}

function optionalText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function noop(): void {}
