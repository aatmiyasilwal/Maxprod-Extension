# Maxprod Extension

Personal productivity companion for Chrome. Maxprod lets you block distracting websites and keep Reddit focused on what matters.

## Features

- **Website blocking:** Add any hostname (e.g. `instagram.com`) in the options page and the extension will block it instantly using Declarative Net Request (DNR) rules.
- **Reddit guardrails:** Flip a single toggle to block Reddit everywhere, then add just the subreddits you want to allow.
- **Quick pause:** Use the popup toggle to temporarily suspend all blocking and resume with one click.

## Project structure

```
extension/
├── background.js        # Manages dynamic DNR rules based on your settings
├── reddit_content_script.js # Enforces Reddit rules even during SPA navigation
├── manifest.json        # Chrome extension manifest (MV3)
├── options.html/.js/.css# Player-friendly settings UI
├── popup.html/.js       # Lightweight enable/disable toggle & shortcut to settings
```

## Getting started

1. Open **chrome://extensions** in Chrome (or **edge://extensions** in Edge).
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the `extension` folder in this repository.
4. Pin “Maxprod” to your toolbar and open the popup to make sure it’s enabled.

### Configuring blocklists

- Right-click the extension icon and choose **Options** (or open the options page from the popup).
- Add websites or allowlisted subreddits. Changes save automatically and take effect immediately.
- Use the “Allowed subreddits” list to bypass the general Reddit block for specific communities.

### Development notes

- Background service worker automatically rebuilds DNR rules when storage changes.
- Storage lives in `chrome.storage.sync` so your blocklists follow you when you sign into Chrome.

## References

- [Chrome extensions overview](https://developer.chrome.com/docs/extensions/)
- [Declarative Net Request API](https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/)
- [Storage API](https://developer.chrome.com/docs/extensions/reference/storage/)