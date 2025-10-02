### **Core Extension Architecture**

*   `manifest.json`: 
    - This is the most important file. 
    - Tells Chrome what it does, what permissions it needs, and what files it uses.
    - Declare your background scripts, content scripts, and any user interface elements here.

*   `background.js`: 
    - Runs in the background, separate from any web page. 
    - Central hub for your extension's logic, listening for browser events like a user trying to visit a new URL. 
    - Where you'll implement the core website and subreddit blocking.

*   `content_script.js`: 
    - Injected directly into web pages. 
    - Can read and modify the content of the page (the DOM).
    - Needed for YouTube channel blocking feature, as the channel name is part of the page content, not the URL itself.

(Potential alternative: use Youtube Data API)

*   `options.html` & `options.js`: 
    - An options page provides a dedicated UI for users to configure the extension. 
    - Where I will build the interface for adding and removing websites, subreddits, and YouTube channels from blocklists.


*   `popup.html` & `popup.js` (later):
    - Perfect place for a simple "On/Off" switch to enable or disable the extension's blocking features quickly.

---

### **Attack Plan by Requirement**

#### **Requirement 1: Block Entire Websites (Instagram, Twitter, etc.)**

1.  **Request Permission:** In `manifest.json`, you'll need to request the `declarativeNetRequest` permission.
2.  **Create a Blocklist:** In your `options.js`, create a simple form where you can input the hostnames of websites to block (e.g., `instagram.com`, `linkedin.com`). Save this list to `chrome.storage`.
3.  **Define Blocking Rules:** In your `background.js`, read the blocklist from `chrome.storage`. For each hostname, create a "rule". A rule for Instagram would look something like this:
    *   **Condition:** If the URL's domain is `instagram.com`.
    *   **Action:** Block the request.
4.  **Update Rules Dynamically:** Your background script should listen for changes to your blocklist in `chrome.storage`. When you add or remove a site on the options page, the background script will automatically add or remove the corresponding blocking rule.

---
#### **Requirement 2: Block Reddit Homepage & Subreddits with Exceptions**

1.  **Use `declarativeNetRequest` again:** The logic will live in `background.js`.
2.  **Block the Homepage:** Create a rule that specifically targets the Reddit homepage. The URL pattern would be `https://www.reddit.com/` (and maybe variants like `old.reddit.com`).
3.  **Block Specific Subreddits:** In your options page, create a list for "blocked subreddits". For each entry (e.g., `r/funny`), your background script will create a rule to block any URL matching the pattern `*://*.reddit.com/r/funny/*`.
4.  **Allow Specific Subreddits (The Bypass):** This is the crucial part. The `declarativeNetRequest` API lets you set a `priority` for each rule. You can create "allow" rules that have a *higher priority* than your "block" rules.
    *   Create a list for "allowed subreddits" on your options page (e.g., `r/MachineLearning`).
    *   For each allowed subreddit, create an `allow` rule with a high priority that matches its URL pattern (e.g., `*://*.reddit.com/r/MachineLearning/*`).
    *   This way, when you visit `r/MachineLearning`, the high-priority "allow" rule will execute first, granting you access before any general blocking rule can be checked.

---

#### **Requirement 3: Block Specific YouTube Channels**

Video URL (`youtube.com/watch?v=...`) doesn't tell you who the creator is. 
For this, you can inspect the content of the page itself. (can instead use YouTube data API)

1.  **Use a Content Script:** In `manifest.json`, configure `content_script.js` to run on all pages that match the pattern `*://*.youtube.com/watch*`.
2.  **Create a Channel Blocklist:** On your `options.html` page, add a section to list the names of YouTube channels you want to block. Save this list to `chrome.storage`.

---

3a.  **Inspect the Page:** When you load a YouTube video, your `content_script.js` will activate. Its job is to:
    *   Find the channel name on the page. You'll need to use your browser's developer tools to "Inspect Element" on a YouTube video page and find the unique HTML tag, class, or ID that contains the channel name (e.g., it might be in an element like `<a class="channel-name-link" ...>`). **Be aware:** YouTube can change its website layout, which might break your script, requiring you to update your selector.
    *   Read the channel name from that element.

4a.  **Check Against Your List:** The content script will then get your blocklist from `chrome.storage` and check if the channel name it just found is on the list.

5a.  **Block the Video:** If there's a match, the content script can take action. Instead of just redirecting the page (which can be jarring), a better user experience would be to modify the page directly. You could have the script find the main video player element and replace it with a simple message like "This channel is on your blocklist."

--- 

3b. **Use the YouTube Data API** to extract the channel name, and from there the process should be much more straightforward.

---

- Non-blocked channels
    1. Barry
    2. Joshua Weissman
    3. KSI official music
    4. Rainbolt 2
    5. secret base
    6. w2s+
    7. cold ones
    8. big wedge
    9. f1

- No input should be allowed when the overlay appears.