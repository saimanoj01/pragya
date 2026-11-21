import React, { useMemo } from 'react';
import { ArrowUpRight, ChevronRight, Link2 } from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { findCrossBookEchoes } from '../../utils/crossBookSynthesis';
import { navigateTo } from '../../utils/navigation';
import { noteHref } from '../../utils/noteVisibility';
import { EYEBROW } from './uiClasses';

export interface CrossBookEchoesProps {
  book: Book;
  allNotes: readonly Note[];
  allBooks: readonly Book[];
}

/**
 * v2: quiet collapsible Cross-Book Echoes section placed below Captured Notes on BookDetailView.
 * Surfaces up to 3 spoiler-safe, non-archived notes from other books sharing direct links or
 * specific #tags. Hidden completely when 0 echoes match.
 */
export const CrossBookEchoes: React.FC<CrossBookEchoesProps> = ({
  book,
  allNotes,
  allBooks,
}) => {
  const echoes = useMemo(
    () => findCrossBookEchoes(book, allNotes, allBooks, 3),
    [allBooks, allNotes, book]
  );

  if (echoes.length === 0) return null;

  return (
    <details
      data-testid="cross-book-echoes-section"
      data-print-expand="true"
      className="group bg-card border border-border rounded-[14px] p-4"
    >
      <summary className="min-h-11 sm:min-h-0 flex items-center justify-between gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className={`inline-flex items-center gap-1.5 ${EYEBROW} num`}>
          <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Echoes from Your Shelf ({echoes.length})</span>
        </span>
        <ChevronRight
          className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-90 print:hidden shrink-0"
          aria-hidden="true"
        />
      </summary>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
        {echoes.map(echo => (
          <article
            key={echo.note.id}
            data-testid={`cross-book-echo-${echo.note.slug}`}
            className="rounded-[12px] bg-surface2/50 border border-border p-3.5 flex flex-col justify-between gap-2.5 min-w-0"
          >
            <div className="space-y-1.5 min-w-0">
              <div className="text-[11px] font-medium text-muted-foreground truncate">
                {echo.book?.title || 'Other Book'}
              </div>
              {echo.note.meta?.title && (
                <h3 className="text-label font-semibold text-foreground line-clamp-2">
                  {echo.note.meta.title}
                </h3>
              )}
              <p className="text-label text-muted-foreground line-clamp-3">
                {echo.note.takeaway || echo.note.quote}
              </p>
            </div>
            <div className="pt-2 border-t border-border/50 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="truncate min-w-0">{echo.reason}</span>
              <button
                type="button"
                onClick={() => navigateTo(noteHref(echo.note, echo.book))}
                className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 px-1 sm:px-0 inline-flex items-center justify-center gap-0.5 font-semibold text-foreground hover:underline shrink-0"
              >
                <span>Open</span>
                <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
              </button>
            </div>
          </article>
        ))}
      </div>
    </details>
  );
};
