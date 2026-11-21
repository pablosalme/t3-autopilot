import { t3 } from "./t3.js";
import type { HostAdapter } from "./types.js";

/**
 * The hosts this version knows, the default one first: a call that names no
 * host is for it. A new host is a file in this folder and one line here (see
 * "Adding a host" in CONTRIBUTING.md).
 */
export const HOSTS: readonly HostAdapter[] = [t3];

/** The host of calls that name none: T3 Code, as in every 0.1 version. */
export const DEFAULT_HOST: HostAdapter = t3;
