/**
 * Who may use the service worker's UI message API.
 *
 * The worker answers `chrome.runtime.sendMessage` for the Board and the popup:
 * claim, rename, arm, disarm and panic. Arm is the one that matters most, since
 * it opens the window in which browser_eval_js runs arbitrary JavaScript in a
 * logged-in session.
 *
 * `runtime.onMessage` does not only hear this extension's own pages. It also
 * hears this extension's CONTENT SCRIPTS, and a content script lives in the same
 * renderer process as the web page it was injected into. The bridge injects
 * into pages on every read, click and fill, so every page it has touched is a
 * page whose renderer can send this worker a message that carries this
 * extension's id. A compromised renderer (a browser exploit on a page the agent
 * visited) could then arm eval for an hour without anybody clicking anything.
 *
 * Chrome's native messaging documentation says it outright: the service worker
 * "must validate sender.origin (or sender.url) and sanitize the message payload
 * before forwarding any data to the native host." This is that validation. The
 * sender's url and origin are filled in by the browser process from the frame
 * that actually sent the message, so a renderer cannot choose them.
 *
 * The Board opens in a tab (`open_in_tab`), so a sender with a `tab` is not
 * refused for that alone: what decides is whether the page is this extension's
 * own page, never whether it sits in a tab.
 */

/**
 * @param {chrome.runtime.MessageSender|undefined} sender
 * @param {string} extensionId  chrome.runtime.id
 * @returns {boolean} true only for a page served from this extension's origin
 */
export function isOwnExtensionPage(sender, extensionId) {
  if (!sender || typeof sender !== 'object') return false
  if (typeof extensionId !== 'string' || extensionId === '') return false
  if (sender.id !== extensionId) return false

  const origin = `chrome-extension://${extensionId}`

  // The trailing slash is load-bearing: without it an id that is a prefix of
  // another extension's id would pass.
  if (typeof sender.url !== 'string' || !sender.url.startsWith(`${origin}/`)) return false

  // Chrome sets `origin` on messages from documents. When it is present it
  // must agree with the url; a disagreement is not a state a real page of this
  // extension can be in.
  if (sender.origin !== undefined && sender.origin !== origin) return false

  return true
}
