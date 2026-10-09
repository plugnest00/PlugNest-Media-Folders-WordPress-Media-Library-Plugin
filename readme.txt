=== PlugNest Media Folders ===
Contributors: ht3dyo
Tags: media library, media folders, folders, media tags, media management
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 2.5.4
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Organize the WordPress media library with real folders, tags, usage scanning and batch tools — without ever touching a file.

== Description ==

PlugNest Media Folders adds real, nested folders to the WordPress media library — plus tags, batch editing, usage scanning and a one-page manager that feels like a file manager. It only writes classification data: your files are never moved, renamed or re-URLed, and deactivating the plugin leaves your site exactly as it was.

**Highlights**

* **Folders that behave like folders** — nest them, drag media in, pin favorites, give them colors. Browse the whole library or just one folder (with its subfolders).
* **Everywhere you pick media** — the same folder filters work in the media modal used by Gutenberg, the Classic editor, Elementor and WooCommerce, and uploads can land straight into the folder you are viewing.
* **Tags & batch tools** — add/remove tags, move, edit fields or permanently delete across hundreds of files, with a full activity log and one-click undo.
* **Usage scanning** — see at a glance which media are in use by your posts and which are unreferenced, then clean up safely.
* **Auto-assign rules** — file new uploads into folders automatically by filename, extension, type or year, with a dry-run preview.
* **Safe by design** — the plugin never calls wp_upload_dir rewrites, never moves or renames files, and never changes a single URL.
* **Multilingual** — English, Traditional Chinese and Simplified Chinese included.

**PlugNest Media Folders Pro** (optional, paid) adds the unused-media cleanup wizard, a missing-alt batch workflow, folder import/export plus one-click import from other folder plugins (FileBird, Real Media Library, HappyFiles, Folders by Premio, Wicked Folders, Enhanced Media Library), folder access roles, and delete-folder-with-files. The free version is fully usable on its own.

== Installation ==

1. Upload the plugin folder to `/wp-content/plugins/`, or install through Plugins → Add New.
2. Activate the plugin.
3. Open **PlugNest Media Folders** in the admin menu and start organizing — nothing else to configure.

== Frequently Asked Questions ==

= Will folders change my file URLs? =

No, never. Folders are a lightweight taxonomy on top of the existing library. Files stay exactly where WordPress put them and every URL keeps working.

= What happens if I deactivate or uninstall the plugin? =

Deactivating simply hides the folders; your media is untouched. Uninstalling removes the plugin's own data (folders, tags, its log table) only — never your files.

= Can one file be in several folders? =

Yes. Unlike file-system tools, PlugNest Media Folders lets a file live in multiple folders at once.

= Does it work with Gutenberg, Elementor and WooCommerce? =

Yes. PlugNest Media Folders extends the standard WordPress media modal, which all of them use — the same folder filters and upload-to-folder are available everywhere.

= Do you support my language? =

English, Traditional Chinese and Simplified Chinese ship with the plugin.

== Changelog ==

= 2.5.4 =
* Performance: the admin dashboard no longer recomputes its full statistics on every read within a request, and folder media counts are computed once per request instead of once per call. Numbers stay live — the cache lives only for the current request.
* Performance: the activity log for auto-assign jobs now appends each batch instead of rewriting the whole snapshot, so a run over a large library is linear rather than quadratic. The 2000-item restore limit is now also enforced on this path.
* Performance: building the site-reference index reads post meta and post content in chunks instead of loading the entire site into memory at once; usage scanning now extends the time limit while it builds.
* Internal: renamed the internal size-sorting meta alias from the legacy `mn_size` to `pnmf_size`.

= 2.5.3 =
* Fixed: the "media attached to this post" panel in the block editor listed empty rows — an attachment ID was passed where a post object was expected.
* Fixed: the file-size index builder could skip batches and report "finished" while entries were still missing, so size sorting could stay incomplete.
* Fixed: permanently deleting several media at once wrote one activity-log entry per file instead of one entry per operation.
* Fixed (permissions): folder access roles were only enforced in the folder tree and the media list query. Folder create/rename/delete/move/color/pin, single-item save, bulk assign, permanent delete, activity-log undo, the native media library and the media modal now enforce them as well — a role-restricted user can no longer bypass them by calling the endpoints directly.
* Fixed: two admin messages added in 2.5.2 were stored with broken placeholders and never translated; their Chinese translations (and the folder-permission message) are now correct.
* Fixed: clicking "Dry run" in Auto-assign silently saved the rules. Previewing no longer writes anything.
* Fixed: the folder/tag counters could show "2" if the term query failed.

= 2.5.2 =
* Fixed a serious bug where the legacy migration routine could delete your auto-assign rules and other settings. If you had configured auto-assign rules, please open the Auto-assign tab and re-save them.
* Fixed: the "missing alt" filter now also applies to "select all matching", so bulk actions act on the same set you see on screen.
* Fixed: folder permission filtering could return a stale result if the current user changed during the same request.
* Fixed: the activity log now shows readable labels for permanent-delete entries instead of raw slugs.
* Performance: the auto-assign job no longer re-queries the entire candidate list on every batch (was quadratic on large libraries).
* Performance: the media list reads file sizes from the existing index instead of touching the filesystem for every item on each page load.
* Fixed: several admin messages were not translatable; Chinese translations added.
* Internal: shared asset-versioning helper; removed leftover legacy prefixes.

= 2.5.1 =
* Security hardening: bulk-edit field templates (title, caption, alt text) are now sanitized before being saved, matching the single-item edit path.
* Fixed: the Pro upgrade dialog now opens when clicking a locked Pro button. The "pro" flag was passed to JavaScript as a string, so on sites without the Pro add-on the upsell dialog never appeared.
* Internal identifiers (function, class, option and taxonomy names) renamed to a unique prefix; existing sites are migrated automatically — folders, tags, colors, roles and logs are preserved with no action needed.

= 2.5.0 =
* Renamed to PlugNest Media Folders.
* Includes all 2.4.2 fixes and improvements (drag-and-drop reliability, folder colors, auto-assign "Videos only", generic default rules, translation fixes).

= 2.4.2 =
* New: auto-assign scope "Videos only".
* Changed: auto-assign default rules are now generic (Videos / Audio / Pictures / Documents by media type) — better starting point for any site.
* New (Pro): missing-alt batch workflow gains one-click "Auto-fill from filename" and "Restore original".
* Fixed: the folder color picker popup could not be closed with its ✕ button.
* Fixed: a template regression that stretched a gap between the upload bar and the three-column layout.
* Fixed: five confirmation dialogs with line breaks were never translated; translations now load correctly.
* Fixed: dragging a media card now always drags — a short "long-press to box-select" timer could hijack the gesture, the full-page "drop to upload" overlay lit up for internal drags, and dragging a card by its thumbnail image (which browsers expose as a virtual file) was treated as an upload instead of a move. Box selection is now started only from empty grid space, the upload overlay appears only for real external files, and internal drags — by card or by thumbnail — always move.

= 2.4.1 =
* Compliance refactor: all Pro-only code moved into the separate PlugNest Media Folders Pro add-on. The free plugin now contains zero gated features — every line of code in it runs fully for everyone.

= 2.4.0 =
* PlugNest Media Folders: same great plugin, new name (the MediaNest name is retired).
* Pro update gate: licensed sites receive Pro updates automatically; unlicensed copies no longer receive Pro updates.

= 2.3.1 =
* Fixed: folder star could not be un-pinned from the pinned section.
* Fixed: folder color rejected valid values; the color picker now offers a full palette plus custom color, with a close button.
* Free version now shows Pro buttons in a locked state with an upgrade guide.
* Folder access roles: the dialog now pre-fills current roles, and restricted folders show a lock badge.

= 2.3.0 =
* New: folder tiles in the center panel (breadcrumbs, drop targets, desktop drag-in).
* New: file-size index and file-size sorting.
* New: Multilingual — English base with Traditional Chinese and Simplified Chinese translations.
* New: PlugNest Media Folders Pro — cleanup wizard, missing-alt workflow, folder import/export, access roles.
* Fixed: button icon alignment in the header actions.

= 2.1.2 =
* Fixed: usage scanning could miss media referenced with escaped/URL-encoded paths (Elementor data).
* Strengthened: bulk cleanup now always re-scans before deleting.
== Upgrade Notice ==

= 2.5.4 =
Optional performance update: lighter admin dashboard, faster auto-assign runs, and a memory-friendlier usage scan. No action needed.

= 2.5.3 =
Recommended for everyone: fixes a folder-permission bypass in bulk actions, an incomplete file-size index, and two Chinese translations that never applied.

= 2.5.2 =
Important: this release fixes a migration bug that could delete your auto-assign rules. Update and then check the Auto-assign tab.

= 2.3.1 =
Recommended for everyone: star un-pin fix, full-featured color picker, and a smoother Pro upgrade path.
