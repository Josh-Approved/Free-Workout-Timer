/**
 * Feature flags.
 *
 * TIP_JAR_ENABLED gates the IAP tip jar — the studio's one funding surface
 * (Apple 3.1.1 forbids external donation link-outs). It powers the Settings
 * "Support" row and the timer-list support link, each opening the canonical
 * TipJarSheet.
 */
export const TIP_JAR_ENABLED: boolean = true;
