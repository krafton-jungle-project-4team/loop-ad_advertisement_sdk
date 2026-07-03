export interface InitOptions {
    apiBaseUrl: string;
    projectId: string;
    userId: string;
    promotionRunId: string;
    debug?: boolean | null;
}

export interface RenderContext {
    pageUrl?: string | null;
    device?: string | null;
    [key: string]: string | number | boolean | null | undefined;
}

interface BaseRenderOptions {
    targetId: string;
    context?: RenderContext | null;
    onImpression?: ((decision: AdvertisementFilledDecision) => void) | null;
    onClick?: ((decision: AdvertisementFilledDecision) => void) | null;
}

export type RenderOptions = BaseRenderOptions &
    (
        | {
              placementId: string;
              placementKey?: string | null;
          }
        | {
              placementId?: string | null;
              placementKey: string;
          }
    );

export interface AdvertisementClient {
    render(options: RenderOptions): Promise<AdvertisementDecision>;
    destroy(): void;
}

export interface ServedAdCreative {
    title: string;
    body: string;
    cta: string;
    targetUrl: string;
}

export interface ServedAdTracking {
    project_id: string;
    user_id: string;
    campaign_id: string;
    promotion_id: string;
    promotion_run_id: string;
    ad_experiment_id: string;
    segment_id: string;
    content_id: string;
    content_option_id: string;
    promotion_channel: "onsite_banner";
    placement_id: string;
    target_url: string;
}

export interface AdvertisementFilledDecision {
    placementId: string;
    placementKey: string;
    status: "filled";
    ad: ServedAdCreative;
    tracking: ServedAdTracking;
}

export interface AdvertisementEmptyDecision {
    placementId: string;
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

        const response = await fetch(buildBannerResolveUrl(this.config, options), {
            method: "GET",
            headers: {
                Accept: "application/json"
            },
            credentials: "omit"
        });
        const payload: unknown = await response.json();

        if (!response.ok) {
            if (
                response.status === 404 &&
                apiErrorCode(payload) === "BANNER_ASSIGNMENT_NOT_FOUND"
            ) {
                return emptyDecision(options.placementId);
            }

            throw new Error(`LoopAdAdvertisementSDK ad request failed with ${response.status}.`);
        }

        return normalizeDecision(unwrapEnvelope(payload));
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
    promotionRunId: string;
    debug: boolean;
}

interface NormalizedRenderOptions {
    placementId: string;
    targetId: string;
    onImpression: ((decision: AdvertisementFilledDecision) => void) | null;
    onClick: ((decision: AdvertisementFilledDecision) => void) | null;
}

function normalizeInitOptions(options: InitOptions): NormalizedInitOptions {
    const apiBaseUrl = trimTrailingSlash(requiredText(options?.apiBaseUrl, "apiBaseUrl"));
    const projectId = requiredText(options?.projectId, "projectId");
    const userId = requiredText(options?.userId, "userId");
    const promotionRunId = requiredText(options?.promotionRunId, "promotionRunId");

    return {
        apiBaseUrl,
        projectId,
        userId,
        promotionRunId,
        debug: options.debug ?? false
    };
}

function normalizeRenderOptions(options: RenderOptions): NormalizedRenderOptions {
    const placementId = optionalText(options?.placementId) || optionalText(options?.placementKey);

    return {
        placementId: requiredText(placementId, "placementId"),
        targetId: requiredText(options?.targetId, "targetId"),
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
    anchor.href = decision.ad.targetUrl || "#";
    anchor.setAttribute("aria-label", decision.ad.title);
    applyTrackingAttributes(anchor, decision);

    const title = document.createElement("strong");
    title.className = "loopad-ad-title";
    title.textContent = decision.ad.title;

    const body = document.createElement("span");
    body.className = "loopad-ad-body";
    body.textContent = decision.ad.body;

    const cta = document.createElement("span");
    cta.className = "loopad-ad-cta";
    cta.textContent = decision.ad.cta;

    anchor.appendChild(title);
    anchor.appendChild(body);
    anchor.appendChild(cta);

    anchor.addEventListener("click", (event) => {
        event.preventDefault();
        options.onClick?.(decision);

        if (decision.ad.targetUrl && typeof window !== "undefined") {
            window.location.assign(decision.ad.targetUrl);
        }
    });

    return anchor;
}

function applyTrackingAttributes(
    anchor: HTMLAnchorElement,
    decision: AdvertisementFilledDecision
): void {
    const attributes = {
        "data-loopad-placement-id": decision.tracking.placement_id,
        "data-loopad-project-id": decision.tracking.project_id,
        "data-loopad-user-id": decision.tracking.user_id,
        "data-loopad-campaign-id": decision.tracking.campaign_id,
        "data-loopad-promotion-id": decision.tracking.promotion_id,
        "data-loopad-promotion-run-id": decision.tracking.promotion_run_id,
        "data-loopad-ad-experiment-id": decision.tracking.ad_experiment_id,
        "data-loopad-segment-id": decision.tracking.segment_id,
        "data-loopad-content-id": decision.tracking.content_id,
        "data-loopad-content-option-id": decision.tracking.content_option_id,
        "data-loopad-promotion-channel": decision.tracking.promotion_channel,
        "data-loopad-target-url": decision.tracking.target_url
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

function buildBannerResolveUrl(
    config: NormalizedInitOptions,
    options: NormalizedRenderOptions
): string {
    const query = new URLSearchParams({
        project_id: config.projectId,
        promotion_run_id: config.promotionRunId,
        user_id: config.userId,
        placement_id: options.placementId
    });

    return `${config.apiBaseUrl}/ad/banner/resolve?${query.toString()}`;
}

function unwrapEnvelope(value: unknown): unknown {
    if (!isRecord(value) || !("data" in value)) {
        throw new Error("LoopAdAdvertisementSDK received an invalid API envelope.");
    }

    return value.data;
}

function normalizeDecision(value: unknown): AdvertisementDecision {
    if (!isRecord(value)) {
        throw new Error("LoopAdAdvertisementSDK received an invalid banner resolve response.");
    }

    const placementId = requiredText(value.placement_id, "placement_id");

    return {
        placementId,
        placementKey: placementId,
        status: "filled",
        ad: normalizeCreative(value),
        tracking: normalizeTracking(value)
    };
}

function emptyDecision(placementId: string): AdvertisementEmptyDecision {
    return {
        placementId,
        placementKey: placementId,
        status: "empty",
        ad: null,
        tracking: null
    };
}

function normalizeCreative(value: Record<string, unknown>): ServedAdCreative {
    return {
        title: requiredText(value.title, "title"),
        body: requiredText(value.body, "body"),
        cta: requiredText(value.cta, "cta"),
        targetUrl: requiredText(value.target_url, "target_url")
    };
}

function normalizeTracking(value: Record<string, unknown>): ServedAdTracking {
    const promotionChannel = requiredText(value.promotion_channel, "promotion_channel");

    if (promotionChannel !== "onsite_banner") {
        throw new Error(
            `LoopAdAdvertisementSDK received unsupported promotion_channel '${promotionChannel}'.`
        );
    }

    return {
        project_id: requiredText(value.project_id, "project_id"),
        user_id: requiredText(value.user_id, "user_id"),
        campaign_id: requiredText(value.campaign_id, "campaign_id"),
        promotion_id: requiredText(value.promotion_id, "promotion_id"),
        promotion_run_id: requiredText(value.promotion_run_id, "promotion_run_id"),
        ad_experiment_id: requiredText(value.ad_experiment_id, "ad_experiment_id"),
        segment_id: requiredText(value.segment_id, "segment_id"),
        content_id: requiredText(value.content_id, "content_id"),
        content_option_id: requiredText(value.content_option_id, "content_option_id"),
        promotion_channel: promotionChannel,
        placement_id: requiredText(value.placement_id, "placement_id"),
        target_url: requiredText(value.target_url, "target_url")
    };
}

function apiErrorCode(value: unknown): string {
    if (!isRecord(value) || !isRecord(value.error)) {
        return "";
    }

    return optionalText(value.error.code);
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
