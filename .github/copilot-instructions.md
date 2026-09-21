# Copilot instructions for catabox

## Always preview changes with a running dev server

After making any change that touches `site/`, `src/render-site.mjs`,
`src/report-template.html`, or any other file that affects the generated
static site, you must start a local preview server before finishing your
turn so the result can be visually inspected in the GitHub Copilot app:

1. Rebuild the site if needed: `npm run build` (or `npm run update` for a
   full fetch/normalize/validate/build pipeline).
2. Start the static preview server: `npm run serve`
   (serves `site/` at `http://localhost:4173/`, zero extra dependencies).
3. Open the preview in the app's **browser canvas** pointed at
   `http://localhost:4173/` so the user can inspect the result without
   leaving the app.
4. Leave the server running in the background (async/detached) rather than
   stopping it once the task appears done, so the user can keep inspecting.

Do not skip this step even for small changes (CSS tweaks, copy edits,
template changes) — always start the preview server and open the browser
canvas so results are visible, not just described.
