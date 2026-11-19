import React from 'react';
import { AlertTriangle, Eye, FileText, Link2, Lock, Sparkles, Unlock } from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { noteCardAriaLabel } from '../../utils/cardFocus';
import { chapterDividerLabel, type ChapterDivider } from '../../utils/chapterFormat';
import { getRenderableAttachments } from '../../utils/metaCodecs';
import { isSafeHttpUrl, navigateTo } from '../../utils/navigation';
import { noteHref } from '../../utils/noteVisibility';
import {
  formatPosDisplay,
  isSealedPrediction,
  isUnlockedPrediction,
} from '../../utils/spoilerMath';
import { ChapterPosChip } from './ChapterPosChip';
import { StreamThumbnail } from './StreamThumbnail';
import { WikiText } from './WikiText';

export interface BookNoteCardProps {
  note: Note;
  book: Book;
  idx: number;
  isFocused: boolean;
  spoiler: boolean;
  revealed: boolean;
  divider?: ChapterDivider;
  hasChapterDividers: boolean;
  allNotes: Note[];
  allBooks: Book[];
  onFocusCard: (idx: number) => void;
  onRevealSlug: (slug: string) => void;
}

function renderNoteBadge(note: Note, book: Book) {
  if (isSealedPrediction(note, book)) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-surface2 border border-border text-foreground">
        <Lock className="w-3 h-3" />
        <span>Sealed Prediction</span>
      </span>
    );
  }
  if (isUnlockedPrediction(note, book)) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-positive/15 border border-positive/30 text-positive">
        <Unlock className="w-3 h-3" />
        <span>Unlocked Prediction</span>
      </span>
    );
  }
  if (note.status === 'inbox') {
    return (
      <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-warning/15 border border-warning/30 text-warning">
        Inbox
      </span>
    );
  }
  if (note.status === 'in-reflection') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-warning/15 border border-warning/30 text-warning">
        <Sparkles className="w-3 h-3" />
        <span>In Reflection</span>
      </span>
    );
  }
  if (note.status === 'atomic') {
    return (
      <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-positive/15 border border-positive/30 text-positive">
        Atomic
      </span>
    );
  }
  return null;
}

/**
 * Captured note stream card (+ optional chapter divider) extracted from BookDetailView.
 */
export const BookNoteCard: React.FC<BookNoteCardProps> = ({
  note,
  book,
  idx,
  isFocused,
  spoiler,
  revealed,
  divider,
  hasChapterDividers,
  allNotes,
  allBooks,
  onFocusCard,
  onRevealSlug,
}) => {
  const attachments = getRenderableAttachments(note.meta);

  return (
    <>
      {divider && (
        <h3
          data-testid={`chapter-divider-${idx}`}
          className="flex items-center gap-3 pt-2 text-eyebrow uppercase text-muted-foreground"
        >
          <span className="truncate">{chapterDividerLabel(divider)}</span>
          <span className="num text-faint">{divider.count}</span>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </h3>
      )}
      <article
        data-testid={`note-card-${note.slug}`}
        data-focused={isFocused ? 'true' : undefined}
        data-jk-focused={isFocused ? 'true' : undefined}
        data-jk-card={idx}
        tabIndex={-1}
        aria-label={noteCardAriaLabel({
          bookTitle: book.title,
          posLabel: formatPosDisplay(note.pos, book.posUnit),
          title: note.meta?.title,
          shielded: spoiler,
        })}
        onFocus={() => onFocusCard(idx)}
        className={`bg-card border rounded-[14px] p-4 space-y-2.5 transition-colors focus:outline-none focus-visible:border-foreground/40 focus-visible:ring-1 focus-visible:ring-ring/40 ${
          isFocused ? 'border-foreground/40 ring-1 ring-ring/40' : 'border-border'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-label text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <ChapterPosChip
              testIdKey={note.slug}
              chapter={note.meta?.chapter}
              pos={note.pos}
              posUnit={book.posUnit}
              positionOnly={spoiler || hasChapterDividers}
            />
            {renderNoteBadge(note, book)}
          </div>
          <button
            type="button"
            onClick={() => navigateTo(noteHref(note, book, revealed))}
            className="min-h-11 sm:min-h-0 font-semibold text-foreground hover:underline whitespace-nowrap"
          >
            View Note ↗
          </button>
        </div>

        {spoiler ? (
          <div
            data-testid={`spoiler-shield-${note.slug}`}
            className="rounded-[10px] bg-surface2/70 border border-border p-4 text-center space-y-2"
          >
            <div className="inline-flex items-center gap-1.5 text-label font-semibold text-foreground">
              <AlertTriangle className="w-4 h-4 text-warning" />
              <span>
                Spoiler Shield (pos {note.pos} &gt; {book.currentPos})
              </span>
            </div>
            <div>
              <button
                type="button"
                data-testid={`spoiler-reveal-btn-${note.slug}`}
                onClick={() => onRevealSlug(note.slug)}
                className="h-11 sm:h-8 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold inline-flex items-center gap-1.5"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>Reveal (or Space)</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            {note.meta.title && <h3 className="text-heading text-foreground">{note.meta.title}</h3>}
            {note.quote && (
              <blockquote className="pl-3 border-l-2 border-border italic text-body text-muted-foreground">
                &ldquo;{note.quote}&rdquo;
              </blockquote>
            )}
            {note.takeaway && (
              <p className="text-body text-foreground">
                <WikiText text={note.takeaway} notes={allNotes} books={allBooks} />
              </p>
            )}
            {attachments.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {attachments.map(att =>
                  att.type === 'image' ? (
                    <StreamThumbnail
                      key={att.id}
                      attachment={att}
                      className="w-14 h-14 rounded-[8px] object-cover border border-border"
                    />
                  ) : isSafeHttpUrl(att.url) ? (
                    <a
                      key={att.id}
                      href={att.url.trim()}
                      data-print-href={att.url.trim()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-h-11 sm:min-h-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label text-foreground hover:bg-secondary"
                    >
                      {att.type === 'doc' ? (
                        <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                      ) : (
                        <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
                      )}
                      <span className="truncate max-w-[160px]">{att.title}</span>
                    </a>
                  ) : (
                    <span
                      key={att.id}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label text-muted-foreground"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      <span className="truncate max-w-[160px]">{att.title}</span>
                    </span>
                  )
                )}
              </div>
            )}
          </>
        )}
      </article>
    </>
  );
};
