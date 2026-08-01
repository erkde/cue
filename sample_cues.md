# Cue marker layout test

This file is designed to test how visible Cue markers sit between different blocks of script content. Enable **Show cues** in the menu, then toggle it off and on to confirm that the text stays in exactly the same place.

The first marker appears between two ordinary paragraphs. There should be enough room to see the line and label clearly, without either paragraph moving when the marker is shown.

<!-- cue:stop message="First stop between two paragraphs." -->

This paragraph follows the first stop. Its first line should remain fixed when Show cues is toggled, and the marker should occupy the existing space above it.

Here is another paragraph before a stop with no authored message. The visible marker should still look identical until it is activated.

<!-- cue:stop -->

## A marker before a heading

The marker above this heading tests the larger margin used by headings. It should remain centred in the available gap rather than pushing the heading down.

<!-- cue:stop message="Pause before the short list." -->

## A short list

- Read the first item at a natural pace.
- Pause briefly before moving to the second item.
- Finish the list and continue into the next paragraph.

<!-- cue:stop message="The list is complete." -->

This paragraph follows a list. The marker should span the script column and its detail should open above the surrounding content without changing the layout.

The final pair of paragraphs gives the page enough content for scrolling. It also makes it easier to compare marker placement at different positions in the viewport.

<!-- cue:stop message="Final layout check. Continue to finish the script." -->

This is the final paragraph. Toggling Show cues should leave every line, including this one, at the same vertical position.
