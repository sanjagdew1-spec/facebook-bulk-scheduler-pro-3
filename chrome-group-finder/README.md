# Group Finder Pro — Chrome Helper (prototype)

This is an isolated Chrome extension prototype. It does not change the deployed Group Finder Pro website, Activity Lab, or Facebook Bulk Scheduler.

## Install in Chrome (Windows)
1. Download this folder from the repository as ZIP, then extract it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the `chrome-group-finder` folder (the folder containing `manifest.json`).
5. Open Facebook in the same Chrome profile and log in normally.
6. Click the Group Finder Pro extension icon, enter keywords (one per line or separated by commas/semicolons), choose a country term, and click **Start search**.

## What it does
- Opens Facebook's own Groups search one keyword at a time in a Chrome tab.
- Reads group links and text that are visible in the page DOM.
- Deduplicates collected group URLs and keeps results in Chrome extension local storage.
- Exports collected results to CSV.
- Does not join groups, post, message, or save anything to the Facebook account.

## Important limitations
- This is a first prototype and must be tested with your own logged-in Chrome session before it can be called working.
- Country is appended as a search term, not a guaranteed geographic filter.
- Facebook may change its page structure, show no results, ask for a checkpoint/CAPTCHA, or restrict automated browsing. The extension does not bypass those controls; stop and complete any legitimate checks manually.
- Only visible Facebook search-result links are collected. Member counts and activity rates are not guessed or fabricated.
- Use responsibly and follow Facebook's terms and rate limits.

## Privacy
The extension uses only the current Facebook page's visible group result text/links and stores its collected shortlist locally in Chrome. It does not ask for or read passwords, cookies, or access tokens.