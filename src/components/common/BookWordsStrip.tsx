import React from 'react';
import { BookOpenText, Lock } from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { getWordEncountersForBook } from '../../utils/lexicon';
import { navigateTo } from '../../utils/navigation';
import { noteHref } from '../../utils/noteVisibility';
import { CARD } from './uiClasses';

export interface BookWordsStripProps {
  book: Book;
  notes: Note[];
}

/**
 * Compact strip on BookDetailView showing contextual words encountered in this book,
 * preserving spoiler shields for encounters ahead of the bookmark.
 */
export const BookWordsStrip: React.FC<BookWordsStripProps> = ({ book, notes }) => {
  const encounters = getWordEncountersForBook(book, notes);
  if (encounters.length === 0) return null;

  return (
    <section
      data-testid="book-words-strip"
      className={`${CARD} space-y-3`}
      aria-label="Words met in this book"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpenText className="w-4 h-4 text-muted-foreground shrink-0" />
          <h2 className="text-heading text-foreground num">
            Words met in this book ({encounters.length})
          </h2>
        </div>
        <a
          href="#/lexicon"
          onClick={e => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            navigateTo('#/lexicon');
          }}
          className="text-label font-medium text-muted-foreground hover:text-foreground whitespace-nowrap"
        >
          Open Lexicon →
        </a>
      </div>

      <div className="flex flex-wrap gap-2">
        {encounters.map(enc => {
          if (enc.shielded) {
            return (
              <button
                key={enc.note.id}
                type="button"
                data-testid={`book-word-chip-shielded-${enc.note.id}`}
                onClick={() => navigateTo(noteHref(enc.note, book, false))}
                className="min-h-9 px-3 py-1.5 rounded-[10px] bg-surface2/80 border border-border text-label text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5"
              >
                <Lock className="w-3 h-3 shrink-0" />
                <span>Shielded word · {enc.posLabel}</span>
              </button>
            );
          }

          return (
            <button
              key={enc.note.id}
              type="button"
              data-testid={`book-word-chip-${enc.note.slug}`}
              onClick={() =>
                navigateTo(
                  `#/book/${encodeURIComponent(book.id)}?note=${encodeURIComponent(enc.note.id)}`
                )
              }
              title={enc.definition || enc.quote || enc.word}
              className="min-h-9 px-3 py-1.5 rounded-[10px] bg-surface2/70 border border-border hover:border-foreground/30 text-label text-foreground inline-flex items-center gap-2 transition-colors"
            >
              <span className="font-semibold">{enc.word}</span>
              <span className="text-muted-foreground num">{enc.posLabel}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
};
