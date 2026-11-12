/**
 * Who may use a route that changes something on this computer: a purchase, a fight, turning the shared game on or
 * off, or quitting.
 */

/**
 * Why a request may not use such a route, or null when it may: it must come from this computer, carry the
 * server's own Origin, and have a JSON body, so a plain form or a page on another site cannot post to it.
 * @returns {{ status: number, error: string } | null}
 */
export function localOnlyRefusal({ local, origin, headers = {} }) {
  if (!local) return { status: 403, error: "Only this computer can do that." };
  if (headers.origin !== origin || !String(headers["content-type"] || "").startsWith("application/json"))
    return { status: 403, error: "Only Goblin Horde's own windows can do that." };
  return null;
}
