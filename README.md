# Group Finder Pro — Chrome Helper

A Chrome extension that reads public Group search results and captures one verified Main Post at a time from a visible Facebook Group feed. It does not read comment text, join groups, post, message, save anything to Facebook, or bypass security checks.

## Install in Chrome (Windows)

1. Download this extension-only ZIP and extract it.
2. Open the extracted folder. Its top level must contain `manifest.json`, `content.js`, and `background.js`.
3. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
5. If an older Group Finder Pro extension is installed, remove the old one first or reload it from the new folder.
6. Pin **Group Finder Pro** from Chrome's Extensions menu.

## One-post Activity Lab workflow

1. Install or reload this extension in Chrome.
2. Open the Group Finder Pro Activity Lab page: https://top-facebook-group-finder-preview.onrender.com/activity-lab.html
3. Click **Run one-post extension + website test**. This sends a deterministic fixture based on the supplied Facebook screenshot through the extension bridge and the website parser; it does not open Facebook.
4. Confirm the report shows Fateh, the caption, 10h, 1 photo, Like 20, Comments 62, Shares 1, and Like/Haha reactions. No comment text should appear.
5. A later real Facebook scan captures only the first Main Post whose header, caption, time, media and first Like/Comment/Share row can be verified. It sends structured fields, not the full page HTML, and stops after one verified post.

The built-in fixture verifies the extension-to-website message contract and website processing. It is not a live Facebook DOM/OCR test; the real feed extraction still needs one final live confirmation after the local fixture passes.

## What it does

- Opens Facebook's group-search page for each keyword.
- Extracts visible group names, URLs, and snippets; deduplicates by URL.
- Stores results in Chrome extension local storage and exports CSV.
- Stops if Facebook presents a login/checkpoint/CAPTCHA or security page.

## Important limitations

- The extension only reads what Facebook renders visibly. Facebook may change its page structure, so results can be incomplete.
- It cannot guarantee that Facebook returns results for every keyword. No fake group names, member counts, or activity metrics are created.
- The country selector adds the country to the search text; it is not a verified geographic filter.
- This is a local Chrome extension, not a Render-hosted web app. That is what lets it use the Facebook session in the same Chrome profile.
- The code has been reviewed and improved, but end-to-end testing must still happen in your logged-in Chrome session. Start with one keyword and confirm real results before using a large list.

## Scope protection

This extension is on the isolated `prototype/chrome-group-finder-automation` branch. It does not modify the deployed Group Finder Pro website, Activity Lab, or locked Facebook Bulk Scheduler features.


## Activity Lab scan behavior (0.4.9)
- Opens the selected Facebook Group in a separate tab and inspects only information visible on that Group page.
- Collects post time plus visible likes, comments, and shares for posts up to 24 hours old.
- Separately records minimal engagement counts for visible posts older than 24 hours and up to 7 days old.
- Stops after the visible feed reaches posts older than 7 days, the page ends, or the safety scroll limit is reached.
- Does not open individual posts, read comment threads, inspect who liked a post, inspect share destinations, or perform likes/comments/shares/joins.
- Activity Lab displays only post number, time, likes, comments, and shares; missing values are shown as Not available.
- Facebook may hide timestamps or engagement counts. The scan reports only values it can actually read and does not estimate missing data.


Version 0.5.0: activity reports now show the visible post author beside each post when Facebook exposes it.
