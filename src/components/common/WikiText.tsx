import type React from 'react';
import type { Book, Note } from '../../types/pragya';
import { noteHref } from '../../utils/noteVisibility';
import { resolveWikilinkTarget, tokenizeWikiText } from '../../utils/wikilinks';

const CHIP =
  'inline-flex items-baseline px-1.5 py-px mx-px rounded-[6px] bg-surface2 border border-border font-mono text-[0.92em] text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 no-underline';
const CHIP_MISSING =
  'inline-flex items-baseline px-1.5 py-px mx-px rounded-[6px] bg-background border border-dashed border-border font-mono text-[0.92em] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 no-underline';

export interface WikiTextProps {
  text: string;
  notes: Note[];
  books: Book[];
  /** Called before navigating (e.g. NotesView stores scroll/focus for Back). */
  onNavigate?: () => void;
}

/**
 * CD C3.1 (ux_spec_cd C.3.1): prose with `[[slug]]` rendered as inline link chips
 * (`inline-wikilink-{slug}`). The label is the user's own text, exactly as typed. A link to a
 * spoiler-shielded note goes to its uuid route (`noteHref`), so its slug/title never surface
 * in the URL; a missing target is a dashed chip leading to "Capture note for [[slug]]".
 * Aliases (old slugs) resolve to the renamed note.
 */
export function WikiText({ text, notes, books, onNavigate }: WikiTextProps): React.ReactElement {
  const bookById = new Map(books.map(b => [b.id, b] as const));
  return (
    <>
      {tokenizeWikiText(text).map((token, idx) => {
        if (token.type === 'text') return <span key={idx}>{token.value}</span>;
        const target = resolveWikilinkTarget(notes, token.raw.slice(2, -2)); // R2-a: legacy-slug fallback
        if (!target) {
          return (
            <a
              key={idx}
              href={`#/note/${encodeURIComponent(token.slug)}`}
              data-testid={`inline-wikilink-${token.slug}`}
              onClick={onNavigate}
              className={CHIP_MISSING}
            >
              {token.raw}
              <span className="sr-only"> (missing note)</span>
            </a>
          );
        }
        const book = bookById.get(target.bookId);
        return (
          <a
            key={idx}
            href={noteHref(target, book)}
            data-testid={`inline-wikilink-${token.slug}`}
            onClick={onNavigate}
            className={CHIP}
          >
            {token.raw}
          </a>
        );
      })}
    </>
  );
}
