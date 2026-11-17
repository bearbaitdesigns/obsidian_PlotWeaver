# Plot Weaver

An Obsidian plugin for outlining a novel with **several plotlines running at once**, **multiple POVs**, **off-screen events**, and the **cause and effect** that ties threads together. Plan loosely in story time, then assign scenes to chapters when you’re ready.

## Features

- **Board.** Plotlines are rows. The columns show either:
  - **Story time**: general events in the story world, for loose planning (“The wedding”, “Ten years earlier”).
  - **Chapters**: reading order. Scenes not yet assigned wait in a **No chapter yet** column.

  Drag cards between cells and reorder them within a cell. Drag row and column headers to reorder them.
- **Parts, prologues, interludes and epilogues.** Sections can be Chapters, Parts, a Prologue, Interludes or an Epilogue. A Part groups the chapters after it, and a card placed in a Part becomes that part’s summary. Manage them in *Manage → Chapters & parts*, from the **Section** button, or from a heading’s ⋯ menu (“Make it a Part”…).
- **Plan big, write small.** Each card can show in **Board and Outline**, **Board only** (big-picture planning or a summary) or **Outline only** (a manuscript scene that doesn’t need its own board card). **Break down into scenes…** splits a card into scene cards. The card becomes their summary on the board and lists its scenes; the scenes take its story time unless they have their own. You can attach or detach scenes at any time, so some cards can stay single scenes while others become summaries.
- **Multiple POVs.** Each scene can have a POV character, shown as a coloured badge. The POV filter fades out the other characters’ scenes.
- **Off-screen events.** Events that happen in the story world but aren’t on the page. They sit on their plotline, can influence other events, and appear in the Outline at their point in story time.
- **Influences.** Link any event to the events it causes, with a note on how. Links are drawn as arrows on the board. Hover over a card to trace them and read the notes.
- **Outline.** Manuscript order, grouped by chapter. Drag scenes to reorder them or move them between chapters, and drag chapter headings to reorder chapters. Flashbacks are marked, and each scene lists what shaped it and what it leads to.
- **Idea shelf.** **Unplaced** (new ideas), **Later** (saved for later) and **Archive**. Restoring an idea puts it back where it was. Deleting always asks you to confirm. Collapse the shelf (**Collapse »** in its header, or the toolbar’s **Shelf** button) to a slim strip that still shows counts, still accepts dropped cards, and has a **+** button for jotting down ideas.
- **Scene notes.** Create a note for any scene from one of your templates, or link a note you already have.
- **Export.** Write the whole outline (manuscript, story-world timeline and shelves) to a markdown note.
- **Full screen.** The board fills the whole display; Esc or the ⤡ button exits. Dialogs and menus still work while it’s on.
- **Linked novels.** A novel can draw on others, such as a worldbuilding history or earlier books in a series. Events in those novels can shape events in this one: pick them under **Shaped by** or **Leads to** in an event’s edit dialog. On the board, a **From linked novels** column shows each outside event beside the plotline it affects, with an arrow into the scene. The Outline, exports and note templates show cross-book links too. Set links in *Manage → Novel → Linked novels*, or from the chip next to the novel menu.
- **Several novels.** Switch between them from the toolbar.

## Install with BRAT

1. Install **Obsidian42 - BRAT** from *Settings → Community plugins → Browse*, and enable it.
2. Run the command **BRAT: Add a beta plugin for testing** and enter `bearbaitdesigns/obsidian_PlotWeaver`.
3. Enable **Plot Weaver** in *Settings → Community plugins*.
4. Open it from the ribbon icon or the command **Plot Weaver: Open board**.

BRAT checks this repository’s releases for updates.

## Install manually

Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/bearbaitdesigns/obsidian_PlotWeaver/releases/latest). Put them in `<your vault>/.obsidian/plugins/plot-weaver/`, then enable the plugin.

## Scene note templates

Put templates in your templates folder (default `Templates`; change it in the plugin settings). These variables are filled in when a note is created:

| Variable | Value |
|---|---|
| `{{title}}`, `{{summary}}` | The scene’s title and summary |
| `{{novel}}`, `{{plotline}}`, `{{pov}}` | Novel, plotline, POV character |
| `{{when}}`, `{{chapter}}` | Story-time event, chapter or section |
| `{{part}}`, `{{partOf}}` | The Part it falls in; the card it was broken out of |
| `{{offscreen}}`, `{{status}}`, `{{id}}` | Flags and the scene’s Plot Weaver id |
| `{{shapedBy}}`, `{{leadsTo}}` | Bullet lists of influence links, with their notes |
| `{{date}}`, `{{time}}` | When the note was created |

Anything else, including Templater `<% %>` code, is left untouched. Plot Weaver can also add its own properties (plotline, POV, chapter and so on) to the new note without overwriting the template’s properties.

## Commands

- **Open board**
- **Toggle full screen**: you can give it a hotkey in *Settings → Hotkeys*
- **Capture an idea**: adds an idea to the Unplaced shelf from anywhere
- **Manage plotlines, POVs, story time and chapters**
- **Export outline to note**
- **Add example series (linked novels)**

## Notes

- Your outline is saved in the plugin’s `data.json` in your vault, so it syncs with the rest of your vault.
- Drag and drop needs a mouse or trackpad. On mobile, move scenes with the edit dialog and card menus instead.

## Releasing (maintainers)

```bash
node scripts/bump.mjs 1.0.1        # updates manifest.json and versions.json
git commit -am "Release 1.0.1"
git tag 1.0.1
git push && git push origin 1.0.1  # the Release action publishes main.js, manifest.json, styles.css
```

You can also run the **Release** action from the Actions tab. It releases the version currently in `manifest.json`. Tags with a suffix, such as `1.1.0-beta.1`, are published as pre-releases for BRAT beta testers.

## License

MIT © bearbaitdesigns
