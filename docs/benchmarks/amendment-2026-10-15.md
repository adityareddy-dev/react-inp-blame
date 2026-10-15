# Amendment, 2026-10-15: app selection for the next run

This amends [protocol-2026-10-14.md](protocol-2026-10-14.md), section "Fixed selection and grading rules", for app selection only. The protocol text is unchanged. Grading, overhead measurement, reporting and the claim boundary are unchanged.

## What changed

- **The protocol** selects fresh apps by sorting candidates by the SHA-256 of `react-inp-blame-2026-10-14:<repository-url>` and taking the first three eligible ones.
- **This amendment** selects from a category shortlist. The categories are money and budgeting, notes, personal dashboards, recipes, bookmarks, calendars, pastebins, polls and blogging, taken from [awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted). The shortlist is filtered to free-software apps with a React front end and a Vite or Next.js build, checked in each repo's package files. Five apps were chosen from the resulting pool, named in [real-apps.md](real-apps.md).
- **Why:** the stated aim is everyday apps rather than stress tests. The seeded ranking, applied to the candidates found so far, gave a pool of small, mostly demonstration-level repos. The selection is therefore a judgement from a small pool, not a random draw.

## Candidate lists and rankings kept

The protocol requires candidate lists and rankings to be kept. These are the ones made before this amendment.

**Seeded ranking, budgeting and todo pool.** Seed string: `react-inp-blame-everyday-2026-10-15:<repository-url>`, sorted ascending by SHA-256 (first 16 hex characters shown). Pool: the four Vite-confirmed local-storage repos found in the finance and todo searches.

1. `HVish/budget-manager-pwa` (`2fb5ed5c72745af2`)
2. `Kezota/Bankist` (`91e0be16625aac47`)
3. `CodeGeniusDev/WealthX` (`9714ae5cd62baad5`)
4. `Danfall369/React-ToDo-App` (`9e6d04f901c10166`)

The first three were not carried into the final cohort, because the amendment switched to the category shortlist. The WealthX URL in its README differs from the search link, and none of the four has been checked for activity or licence.

**Other pools searched, not ranked:**
- Notes, todo and habit searches: [Note-Todo](https://github.com/eclipse-dev3/Note-Todo) had no build tool stated, so it was not confirmed.
- Kanban and recipe searches: no recipe apps were found.
- npm top 300 and top 1,000 by weekly downloads: these are libraries and developer tools, not complete apps. Only storybook and react-email are runnable apps in that set, and both are developer tools.
- awesome-selfhosted categories: the filter results are in the cohort section of [real-apps.md](real-apps.md).

## What is not claimed

- No app in the final cohort has been cloned, built or run.
- The five are not a random sample of everyday apps.
- No result is implied by this amendment.
- The dated schedule in the protocol is unchanged. Selection was done on 2026-10-15, ahead of the 2026-10-16 milestone.
