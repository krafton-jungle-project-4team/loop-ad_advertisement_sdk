export interface InitOptions {
    apiBaseUrl: string;
    projectId: string;
    userId?: string;
    subjectId?: string;
    promotionRunId: string;
    debug?: boolean | null;
}

export interface RenderOptions {
    placementId: string;
    targetId: string;
    on_loaded?: ((event: { attribution: LoopAdAttribution }) => void) | null;
    on_viewable?: ((event: { attribution: LoopAdAttribution }) => void) | null;
    on_click?: ((event: { attribution: LoopAdAttribution; click_url: string }) => void) | null;
}

export interface AdvertisementClient {
    render(options: RenderOptions): Promise<AdvertisementDecision>;
    destroy(): void;
}

export interface LoopAdAttribution {
    project_id: string;
    campaign_id: string;
    promotion_id: string;
    promotion_run_id: string;
    ad_experiment_id: string;
    segment_id: string;
    content_id: string;
    content_option_id: string;
    creative_id: string;
    promotion_channel: "onsite_banner";
    target_url: string;
    placement_id?: string;
    redirect_id?: string;
}

export interface BannerCreative {
    creative_id: string;
    creative_format: "banner_html";
    html_url: string;
    width: number;
    height: number;
    click_url: string;
    target_url: string;
    sandbox: {
        allow_scripts: true;
        allow_same_origin: false;
        allow_popups: boolean;
    };
}

export interface AdvertisementFilledDecision {
    status: "filled";
    placementId: string;
    creative: BannerCreative;
    attribution: LoopAdAttribution;
}

export interface AdvertisementEmptyDecision {
    status: "empty";
    placementId: string;
    reason: "assignment_not_found" | "artifact_not_ready" | "artifact_failed";
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

        const iframe = createBannerIframe(decision);
        target.appendChild(iframe);

        const cleanup = combineCleanups(
            observeIframeLoad(iframe, decision, renderOptions.on_loaded),
            observeViewability(iframe, decision, renderOptions.on_viewable),
            observeClickMessage(decision, renderOptions.on_click)
        );
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
    identityQueryName: "user_id" | "subject_id";
    identityValue: string;
    promotionRunId: string;
    debug: boolean;
}

interface NormalizedRenderOptions {
    placementId: string;
    targetId: string;
    on_loaded: ((event: { attribution: LoopAdAttribution }) => void) | null;
    on_viewable: ((event: { attribution: LoopAdAttribution }) => void) | null;
    on_click: ((event: { attribution: LoopAdAttribution; click_url: string }) => void) | null;
}

function normalizeInitOptions(options: InitOptions): NormalizedInitOptions {
    const apiBaseUrl = trimTrailingSlash(requiredText(options?.apiBaseUrl, "apiBaseUrl"));
    const projectId = requiredText(options?.projectId, "projectId");
    const identity = normalizeIdentity(options);
    const promotionRunId = requiredText(options?.promotionRunId, "promotionRunId");

    return {
        apiBaseUrl,
        projectId,
        identityQueryName: identity.queryName,
        identityValue: identity.value,
        promotionRunId,
        debug: options.debug ?? false
    };
}

function normalizeIdentity(options: InitOptions): {
    queryName: "user_id" | "subject_id";
    value: string;
} {
    const userId = optionalText(options?.userId);
    const subjectId = optionalText(options?.subjectId);
    if ((userId && subjectId) || (!userId && !subjectId)) {
        throw new Error(
            "LoopAdAdvertisementSDK requires exactly one of userId or subjectId."
        );
    }
    if (subjectId) {
        if (!/^sub_[0-9a-f]{64}$/.test(subjectId)) {
            throw new Error(
                "LoopAdAdvertisementSDK subjectId must be a sub_ prefixed SHA-256 digest."
            );
        }
        return { queryName: "subject_id", value: subjectId };
    }
    return { queryName: "user_id", value: userId as string };
}

function normalizeRenderOptions(options: RenderOptions): NormalizedRenderOptions {
    return {
        placementId: requiredText(options?.placementId, "placementId"),
        targetId: requiredText(options?.targetId, "targetId"),
        on_loaded: options.on_loaded ?? null,
        on_viewable: options.on_viewable ?? null,
        on_click: options.on_click ?? null
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

function createBannerIframe(decision: AdvertisementFilledDecision): HTMLIFrameElement {
    const iframe = document.createElement("iframe");
    iframe.className = "loopad-ad-frame";
    iframe.src = decision.creative.html_url;
    iframe.width = String(decision.creative.width);
    iframe.height = String(decision.creative.height);
    iframe.setAttribute("title", "LoopAd advertisement");
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("sandbox", sandboxTokens(decision.creative.sandbox));
    iframe.setAttribute("data-loopad-placement-id", decision.placementId);
    iframe.setAttribute("data-loopad-project-id", decision.attribution.project_id);
    iframe.setAttribute("data-loopad-campaign-id", decision.attribution.campaign_id);
    iframe.setAttribute("data-loopad-promotion-id", decision.attribution.promotion_id);
    iframe.setAttribute("data-loopad-promotion-run-id", decision.attribution.promotion_run_id);
    iframe.setAttribute("data-loopad-ad-experiment-id", decision.attribution.ad_experiment_id);
    iframe.setAttribute("data-loopad-segment-id", decision.attribution.segment_id);
    iframe.setAttribute("data-loopad-content-id", decision.attribution.content_id);
    iframe.setAttribute("data-loopad-content-option-id", decision.attribution.content_option_id);
    iframe.setAttribute("data-loopad-creative-id", decision.attribution.creative_id);
    iframe.setAttribute("data-loopad-channel", decision.attribution.promotion_channel);
    iframe.setAttribute("data-loopad-target-url", decision.attribution.target_url);
    return iframe;
}

function sandboxTokens(sandbox: BannerCreative["sandbox"]): string {
    const tokens = [];
    if (sandbox.allow_scripts) {
        tokens.push("allow-scripts");
    }
    if (sandbox.allow_same_origin) {
        tokens.push("allow-same-origin");
    }
    if (sandbox.allow_popups) {
        tokens.push("allow-popups");
    }
    return tokens.join(" ");
}

function observeIframeLoad(
    iframe: HTMLIFrameElement,
    decision: AdvertisementFilledDecision,
    callback: ((event: { attribution: LoopAdAttribution }) => void) | null
): () => void {
    if (!callback) {
        return noop;
    }

    const handler = () => callback({ attribution: decision.attribution });
    iframe.addEventListener("load", handler);
    return () => iframe.removeEventListener("load", handler);
}

function observeViewability(
    element: HTMLElement,
    decision: AdvertisementFilledDecision,
    callback: ((event: { attribution: LoopAdAttribution }) => void) | null
): () => void {
    if (!callback) {
        return noop;
    }

    let fired = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let observer: IntersectionObserver | null = null;

    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
    const fire = () => {
        if (fired) {
            return;
        }
        fired = true;
        clearTimer();
        callback({ attribution: decision.attribution });
        observer?.disconnect();
    };

    if (typeof IntersectionObserver !== "function") {
        timer = setTimeout(fire, 1000);
        return clearTimer;
    }

    observer = new IntersectionObserver(
        (entries) => {
            const viewable = entries.some(
                (entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5
            );
            if (viewable && !timer) {
                timer = setTimeout(fire, 1000);
            }
            if (!viewable) {
                clearTimer();
            }
        },
        { threshold: [0, 0.5] }
    );
    observer.observe(element);

    return () => {
        clearTimer();
        observer?.disconnect();
    };
}

function observeClickMessage(
    decision: AdvertisementFilledDecision,
    callback: ((event: { attribution: LoopAdAttribution; click_url: string }) => void) | null
): () => void {
    if (typeof window === "undefined") {
        return noop;
    }

    const handler = (event: MessageEvent) => {
        if (!isLoopAdClickMessage(event.data)) {
            return;
        }

        callback?.({
            attribution: decision.attribution,
            click_url: decision.creative.click_url
        });

        window.location.assign(decision.creative.click_url);
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
}

function isLoopAdClickMessage(value: unknown): boolean {
    return isRecord(value) && value.type === "loopad:click";
}

function buildBannerResolveUrl(
    config: NormalizedInitOptions,
    options: NormalizedRenderOptions
): string {
    const query = new URLSearchParams({
        project_id: config.projectId,
        promotion_run_id: config.promotionRunId,
        placement_id: options.placementId
    });
    query.set(config.identityQueryName, config.identityValue);

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

    if (value.status === "empty") {
        return {
            status: "empty",
            placementId: requiredText(value.placement_id, "placement_id"),
            reason: normalizeEmptyReason(value.reason)
        };
    }

    if (value.status !== "filled") {
        throw new Error("LoopAdAdvertisementSDK received an invalid banner status.");
    }

    const creative = normalizeCreative(value.creative);
    const attribution = normalizeAttribution(value.attribution);
    const placementId = requiredText(value.placement_id, "placement_id");

    return {
        status: "filled",
        placementId,
        creative,
        attribution: {
            ...attribution,
            placement_id: attribution.placement_id ?? placementId
        }
    };
}

function normalizeEmptyReason(value: unknown): AdvertisementEmptyDecision["reason"] {
    if (
        value === "assignment_not_found" ||
        value === "artifact_not_ready" ||
        value === "artifact_failed"
    ) {
        return value;
    }
    throw new Error("LoopAdAdvertisementSDK received an invalid empty reason.");
}

function normalizeCreative(value: unknown): BannerCreative {
    if (!isRecord(value)) {
        throw new Error("LoopAdAdvertisementSDK received an invalid creative.");
    }
    const creativeFormat = requiredText(value.creative_format, "creative.creative_format");
    if (creativeFormat !== "banner_html") {
        throw new Error(`LoopAdAdvertisementSDK received unsupported creative_format '${creativeFormat}'.`);
    }
    const sandbox = normalizeSandbox(value.sandbox);
    return {
        creative_id: requiredText(value.creative_id, "creative.creative_id"),
        creative_format: "banner_html",
        html_url: requiredUrl(value.html_url, "creative.html_url"),
        width: requiredPositiveInteger(value.width, "creative.width"),
        height: requiredPositiveInteger(value.height, "creative.height"),
        click_url: requiredUrl(value.click_url, "creative.click_url"),
        target_url: requiredUrl(value.target_url, "creative.target_url"),
        sandbox
    };
}

function normalizeSandbox(value: unknown): BannerCreative["sandbox"] {
    if (!isRecord(value)) {
        throw new Error("LoopAdAdvertisementSDK received an invalid sandbox.");
    }
    if (value.allow_scripts !== true || value.allow_same_origin !== false) {
        throw new Error("LoopAdAdvertisementSDK received unsupported sandbox flags.");
    }
    return {
        allow_scripts: true,
        allow_same_origin: false,
        allow_popups: Boolean(value.allow_popups)
    };
}

function normalizeAttribution(value: unknown): LoopAdAttribution {
    if (!isRecord(value)) {
        throw new Error("LoopAdAdvertisementSDK received invalid attribution.");
    }
    const promotionChannel = requiredText(value.promotion_channel, "attribution.promotion_channel");
    if (promotionChannel !== "onsite_banner") {
        throw new Error(
            `LoopAdAdvertisementSDK received unsupported promotion_channel '${promotionChannel}'.`
        );
    }
    const attribution: LoopAdAttribution = {
        project_id: requiredText(value.project_id, "attribution.project_id"),
        campaign_id: requiredText(value.campaign_id, "attribution.campaign_id"),
        promotion_id: requiredText(value.promotion_id, "attribution.promotion_id"),
        promotion_run_id: requiredText(value.promotion_run_id, "attribution.promotion_run_id"),
        ad_experiment_id: requiredText(value.ad_experiment_id, "attribution.ad_experiment_id"),
        segment_id: requiredText(value.segment_id, "attribution.segment_id"),
        content_id: requiredText(value.content_id, "attribution.content_id"),
        content_option_id: requiredText(value.content_option_id, "attribution.content_option_id"),
        creative_id: requiredText(value.creative_id, "attribution.creative_id"),
        promotion_channel: "onsite_banner",
        target_url: requiredUrl(value.target_url, "attribution.target_url")
    };
    const placementId = optionalText(value.placement_id);
    const redirectId = optionalText(value.redirect_id);

    if (placementId) {
        attribution.placement_id = placementId;
    }
    if (redirectId) {
        attribution.redirect_id = redirectId;
    }

    return attribution;
}

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

function requiredUrl(value: unknown, field: string): string {
    const text = requiredText(value, field);
    try {
        const url = new URL(text);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("invalid protocol");
        }
        return text;
    } catch {
        throw new Error(`LoopAdAdvertisementSDK requires ${field} to be an HTTP URL.`);
    }
}

function requiredPositiveInteger(value: unknown, field: string): number {
    const numberValue = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(numberValue) || numberValue <= 0) {
        throw new Error(`LoopAdAdvertisementSDK requires ${field}.`);
    }
    return numberValue;
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

function combineCleanups(...cleanups: Array<() => void>): () => void {
    return () => {
        for (const cleanup of cleanups) {
            cleanup();
        }
    };
}

function noop(): void {}
