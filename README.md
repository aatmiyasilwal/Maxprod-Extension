# Maxprod Extension

Personal productivity companion for Chrome. Maxprod lets you block distracting websites and keep Reddit focused on what matters.

## Features

- **Website blocking:** Add any hostname (e.g. `instagram.com`) in the options page and the extension will block it instantly—including already open tabs—with a full-page, scroll-locking overlay powered by Declarative Net Request (DNR) rules.
- **Reddit guardrails:** Flip a single toggle to block Reddit everywhere, then add just the subreddits you want to allow.
- **YouTube channel blocklist:** Store a YouTube Data API key in the local `.env` file and list any channels to blacklist; videos from those channels are overlaid and paused automatically, while the YouTube homepage stays accessible.
- **YouTube Shorts toggle:** Flip one switch to block every `youtube.com/shorts` page with the same full overlay and scroll lock.
- **Quick pause:** Use the popup toggle to temporarily suspend all blocking and resume with one click.

## Project structure

```
extension/
├── background.js        # Manages dynamic DNR rules based on your settings
├── reddit_content_script.js # Enforces Reddit rules even during SPA navigation
├── youtube_content_script.js # Applies YouTube channel blocklist & Shorts toggle logic
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
- Place your YouTube Data API key in `extension/.env` (see below), then list any YouTube channel IDs or handles you want to blacklist; only videos from those channels are blocked.
- Enable the “Block YouTube Shorts” toggle to replace any Shorts page with the Maxprod overlay.

### YouTube controls

1. Create an API key in the [Google Cloud Console](https://console.cloud.google.com/apis/dashboard) and enable the **YouTube Data API v3**.
2. Copy `extension/.env.example` to `extension/.env`, then set the `YOUTUBE_API_KEY` value.
3. In the options page, add channel IDs (`UC…`) or handles (e.g. `@creator`) to the block list. Only videos originating from those channels will be overlaid and paused; all other YouTube content remains accessible.
4. Use the Shorts toggle to instantly block every `youtube.com/shorts/<id>` page—perfect when you want long-form videos only.

### Development notes

- Background service worker automatically rebuilds DNR rules when storage changes.
- Storage lives in `chrome.storage.sync` so your blocklists follow you when you sign into Chrome.
- Sensitive credentials stay local: `extension/.env` is ignored by git and not read from synced storage.

## References

- [Chrome extensions overview](https://developer.chrome.com/docs/extensions/)
- [Declarative Net Request API](https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/)
- [Storage API](https://developer.chrome.com/docs/extensions/reference/storage/)