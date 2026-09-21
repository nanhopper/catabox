# Copilot instructions for catabox

## Always preview changes with a running dev server

After making any change that touches `site/`, `src/render-site.mjs`,
`src/report-template.html`, or any other file that affects the generated
static site, you must start a local preview server before finishing your
turn so the result can be visually inspected in the GitHub Copilot app:

1. Rebuild the site if needed: `npm run build` (or `npm run update` for a
   full fetch/normalize/validate/build pipeline).
2. Check whether the preferred preview port (`4173`) is already listening.
   Never reuse an occupied port, because it may serve another worktree's
   site. If it is occupied, select a free port (for example `4174`) and pass
   it to the server: `npm run serve -- 4174`.
3. Start the static preview server on the selected port. The server has zero
   extra dependencies and serves the generated `site/` directory.
4. Verify that `http://localhost:<selected-port>/` responds successfully and
   contains the current worktree's generated output before opening it.
5. Open the preview in the app's **browser canvas** pointed at the exact
   verified URL so the user can inspect the result without leaving the app.
6. Leave the server running in the background (async/detached) rather than
   stopping it once the task appears done, so the user can keep inspecting.

Do not skip this step even for small changes (CSS tweaks, copy edits,
template changes) — always start the preview server and open the browser
canvas so results are visible, not just described.
