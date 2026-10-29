# Group Finder Pro — Chrome Helper

A local Chrome extension that reads group names and links rendered visibly in Facebook's own group-search results. It does not join groups, post, message, save anything to Facebook, or bypass security checks.

## Install in Chrome (Windows)

1. Open this branch folder on GitHub: https://github.com/sanjagdew1-spec/facebook-bulk-scheduler-pro-3/tree/prototype/chrome-group-finder-automation/chrome-group-finder
2. Download the repository branch as a ZIP using **Code → Download ZIP**, then extract it.
3. Open the extracted repository folder and then open `chrome-group-finder`.
4. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
5. Click **Load unpacked** and select the `chrome-group-finder` folder containing `manifest.json`.
6. Pin **Group Finder Pro** from Chrome's Extensions menu.
7. In that same Chrome profile, sign in to Facebook normally. Open the extension.
8. Enter keywords (one per line, comma, or semicolon), select a country or tick **Only USA**, then press **Start search**.
9. Keep the Facebook search tab open while it processes keywords. Reopen the extension to review results or export CSV.

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
