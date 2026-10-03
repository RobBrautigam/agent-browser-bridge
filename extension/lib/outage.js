/**
 * When a failed board read means the broker is down, and when it only means
 * this profile's own link is reconnecting.
 *
 * The options page and the popup reach the broker through this profile's
 * link, so a link that drops and comes back fails a poll or two while the
 * broker answers every other profile throughout. Both pages used to call the
 * first failed poll "The broker is not answering", which sends the operator to
 * restart a broker that is up. A reconnect is a backoff of about a second, one
 * host start and one REGISTER, so the outage card waits for a failure that has
 * outlasted that; until then the page says the profile is reconnecting.
 *
 * Pure and dependency-free, so both pages can import it statically and the
 * test suite can drive it directly.
 */

export const OUTAGE_GRACE_MS = 6_000

/**
 * @param {number|null} since epoch ms of the first failed poll in a row, or null
 * @param {number} [now]
 * @returns {'ok'|'reconnecting'|'down'}
 */
export function outageState(since, now = Date.now()) {
  if (since == null) return 'ok'
  return now - since >= OUTAGE_GRACE_MS ? 'down' : 'reconnecting'
}
