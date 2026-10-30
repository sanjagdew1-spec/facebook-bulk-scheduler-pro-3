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


## Activity Lab scan behavior (0.4.8)
- Opens the selected Facebook Group in a separate tab and inspects only information visible on that Group page.
- Collects post time plus visible likes, comments, and shares for posts up to 24 hours old.
- Separately records minimal engagement counts for visible posts older than 24 hours and up to 7 days old.
- Stops after the visible feed reaches posts older than 7 days, the page ends, or the safety scroll limit is reached.
- Does not open individual posts, read comment threads, inspect who liked a post, inspect share destinations, or perform likes/comments/shares/joins.
- Activity Lab displays only post number, time, likes, comments, and shares; missing values are shown as Not available.
- Facebook may hide timestamps or engagement counts. The scan reports only values it can actually read and does not estimate missing data.
