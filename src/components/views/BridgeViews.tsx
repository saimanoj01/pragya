import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Eye,
  FileText,
  Link2,
  Sparkles,
} from 'lucide-react';
import type { Book } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { formatWhenDoDisplay } from '../../utils/deltaFormat';
import { isSafeHttpUrl, navigateTo } from '../../utils/navigation';
import {
  computePercentDisplay,
  formatPosDisplay,
  isNoteSpoiler,
} from '../../utils/spoilerMath';
import { computeBacklinks, extractNoteWikilinks } from '../../utils/wikilinks';
import { DriveImage } from '../common/DriveImage';

export const BookDetailPreview: React.FC<{
  bookId: string;
  onEditBook: (book: Book) => void;
  onOpenCaptureForBook: (bookId: string) => void;
}> = ({ bookId, onEditBook, onOpenCaptureForBook }) => {
  const { books, notes } = usePragya();
  const [revealedSlugs, setRevealedSlugs] = useState<Set<string>>(new Set());

  const book = books.find(b => b.id === bookId);
  const bookNotes = useMemo(
    () =>
      notes
        .filter(n => n.bookId === bookId)
        .sort((a, b) => a.pos - b.pos || a.createdAt.localeCompare(b.createdAt)),
    [bookId, notes]
  );

  if (!book) {
    return (
      <div data-testid="book-detail-view" className="py-8 space-y-4">
        <button
          type="button"
          data-testid="back-to-shelf-btn"
          onClick={() => navigateTo('#/shelf')}
          className="inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Shelf</span>
        </button>
        <div className="bg-card border border-border rounded-[14px] p-6 text-body text-muted-foreground">
          Book not found.
        </div>
      </div>
    );
  }

  const pct = computePercentDisplay(book);

  return (
    <div data-testid="book-detail-view" className="py-6 space-y-6">
      <button
        type="button"
        data-testid="back-to-shelf-btn"
        onClick={() => navigateTo('#/shelf')}
        className="inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Shelf</span>
      </button>

      <section className="bg-card border border-border rounded-[14px] p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-surface2 border border-border text-muted-foreground">
                {book.format}
              </span>
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-surface2 border border-border text-muted-foreground">
                {book.kind}
              </span>
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-surface2 border border-border text-foreground">
                {book.status}
              </span>
            </div>
            <h1 className="text-display-l text-foreground tracking-tight">{book.title}</h1>
            <p className="text-body text-muted-foreground">by {book.author}</p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onEditBook(book)}
              className="h-9 px-3 rounded-[10px] bg-surface2 border border-border text-label font-medium text-foreground hover:bg-secondary"
            >
              Edit Book
            </button>
            <button
              type="button"
              onClick={() => onOpenCaptureForBook(book.id)}
              className="h-9 px-3.5 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90"
            >
              + Capture
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-label num">
            <span>
              {formatPosDisplay(book.currentPos, book.posUnit)}
              {book.totalPos > 0 ? ` / ${book.totalPos}` : ''}
            </span>
            <span className="text-muted-foreground">{pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-surface2 overflow-hidden">
            <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-heading text-foreground num">Captured Notes ({bookNotes.length})</h2>
        {bookNotes.length === 0 ? (
          <div className="bg-card border border-border rounded-[14px] p-6 text-center text-body text-muted-foreground">
            No notes captured for this book yet.
          </div>
        ) : (
          <div className="space-y-3">
            {bookNotes.map(note => {
              const spoiler = isNoteSpoiler(note, book) && !revealedSlugs.has(note.slug);
              return (
                <article
                  key={note.id}
                  data-testid={`note-card-${note.slug}`}
                  className="bg-card border border-border rounded-[14px] p-4 space-y-2"
                >
                  <div className="flex items-center justify-between text-label text-muted-foreground">
                    <span className="num">{formatPosDisplay(note.pos, book.posUnit)}</span>
                    <button
                      type="button"
                      onClick={() => navigateTo(`#/note/${encodeURIComponent(note.slug)}`)}
                      className="font-semibold text-foreground hover:underline"
                    >
                      View Note ↗
                    </button>
                  </div>

                  {spoiler ? (
                    <div
                      data-testid={`spoiler-shield-${note.slug}`}
                      className="rounded-[10px] bg-surface2/70 border border-border p-4 text-center space-y-2"
                    >
                      <div className="inline-flex items-center gap-1.5 text-label font-semibold">
                        <AlertTriangle className="w-4 h-4 text-warning" />
                        <span>Spoiler Shield (pos {note.pos} &gt; {book.currentPos})</span>
                      </div>
                      <div>
                        <button
                          type="button"
                          data-testid={`spoiler-reveal-btn-${note.slug}`}
                          onClick={() =>
                            setRevealedSlugs(prev => {
                              const next = new Set(prev);
                              next.add(note.slug);
                              return next;
                            })
                          }
                          className="h-8 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold inline-flex items-center gap-1.5"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Reveal</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {note.meta.title && (
                        <h3 className="text-heading text-foreground">{note.meta.title}</h3>
                      )}
                      {note.quote && (
                        <blockquote className="pl-3 border-l-2 border-border italic text-body text-muted-foreground">
                          &ldquo;{note.quote}&rdquo;
                        </blockquote>
                      )}
                      {note.takeaway && <p className="text-body text-foreground">{note.takeaway}</p>}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

export const NoteDetailPreview: React.FC<{ noteSlug: string }> = ({ noteSlug }) => {
  const { books, notes } = usePragya();
  const note = notes.find(n => n.slug === noteSlug);
  const book = note ? books.find(b => b.id === note.bookId) : undefined;
  const wikilinks = useMemo(() => (note ? extractNoteWikilinks(note) : []), [note]);
  const backlinks = useMemo(() => (note ? computeBacklinks(note.slug, notes) : []), [note, notes]);

  if (!note) {
    return (
      <div data-testid="note-detail-view" className="py-8 space-y-4">
        <button
          type="button"
          data-testid="back-to-notes-btn"
          onClick={() => navigateTo('#/notes')}
          className="inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Notes</span>
        </button>
        <div className="bg-card border border-border rounded-[14px] p-6 text-body text-muted-foreground">
          Note &ldquo;{noteSlug}&rdquo; not found.
        </div>
      </div>
    );
  }

  const deltaDisplay = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);

  return (
    <div data-testid="note-detail-view" className="py-6 space-y-6">
      <button
        type="button"
        data-testid="back-to-notes-btn"
        onClick={() => navigateTo('#/notes')}
        className="inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Notes</span>
      </button>

      <article className="bg-card border border-border rounded-[14px] p-6 space-y-5">
        <div className="space-y-1">
          <div className="text-label text-muted-foreground flex flex-wrap items-center gap-2">
            <span className="font-semibold text-foreground">{book?.title || 'Book'}</span>
            <span>·</span>
            <span className="num">{formatPosDisplay(note.pos, book?.posUnit || 'page')}</span>
            <span>·</span>
            <span className="uppercase text-[11px] font-semibold">{note.status}</span>
          </div>
          <h1 className="text-display-l text-foreground tracking-tight">
            {note.meta.title || note.slug}
          </h1>
        </div>

        {note.status === 'in-reflection' && note.meta.socraticQuestions && (
          <div
            data-testid="socratic-recovery-banner"
            className="rounded-[12px] bg-surface2 border border-border p-4 space-y-2"
          >
            <div className="flex items-center gap-1.5 text-label font-semibold text-warning uppercase tracking-wide">
              <Sparkles className="w-4 h-4" />
              <span>Socratic Reflection Prompts</span>
            </div>
            <ul className="list-disc pl-5 space-y-1 text-body text-foreground">
              {note.meta.socraticQuestions.map((q, idx) => (
                <li key={idx}>{q}</li>
              ))}
            </ul>
          </div>
        )}

        {note.quote && (
          <blockquote className="pl-4 border-l-2 border-foreground/40 italic text-heading text-muted-foreground">
            &ldquo;{note.quote}&rdquo;
          </blockquote>
        )}

        {note.takeaway && (
          <div className="space-y-1">
            <div className="text-eyebrow uppercase text-muted-foreground">
              Core Takeaway / Why I Liked It
            </div>
            <p className="text-body text-foreground">{note.takeaway}</p>
          </div>
        )}

        {wikilinks.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-eyebrow uppercase text-muted-foreground">Related Concepts:</span>
            {wikilinks.map(slug => (
              <button
                key={slug}
                type="button"
                data-testid={`wikilink-chip-${slug}`}
                onClick={() => navigateTo(`#/note/${encodeURIComponent(slug)}`)}
                className="px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label font-mono text-foreground hover:bg-secondary"
              >
                [[{slug}]]
              </button>
            ))}
          </div>
        )}

        {note.contextMechanism && (
          <div className="space-y-1 pt-2 border-t border-border/60">
            <div className="text-eyebrow uppercase text-muted-foreground">Context &amp; Mechanism</div>
            <p className="text-body text-foreground">{note.contextMechanism}</p>
          </div>
        )}

        {(deltaDisplay.triggerBody || deltaDisplay.actionBody) && (
          <div className="rounded-[12px] bg-surface2/70 border border-border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-eyebrow uppercase text-muted-foreground">Behavioral Delta</span>
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-primary text-primary-foreground">
                {note.deltaStatus}
              </span>
            </div>
            {deltaDisplay.triggerBody && (
              <p className="text-body text-foreground">
                <strong className="font-semibold">WHEN</strong> {deltaDisplay.triggerBody}
              </p>
            )}
            {deltaDisplay.actionBody && (
              <p className="text-body text-foreground font-mono text-[13px]">
                <strong className="font-semibold">DO</strong> {deltaDisplay.actionBody}
              </p>
            )}
          </div>
        )}

        {note.critique && (
          <div className="space-y-1 pt-2 border-t border-border/60">
            <div className="text-eyebrow uppercase text-muted-foreground">
              Socratic Critique &amp; Boundary Conditions
            </div>
            <p className="text-body text-foreground">{note.critique}</p>
          </div>
        )}

        {note.meta.attachments.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border/60">
            <div className="text-eyebrow uppercase text-muted-foreground">Attachments</div>
            <div className="flex flex-wrap gap-3">
              {note.meta.attachments.map(att =>
                att.type === 'image' ? (
                  <DriveImage
                    key={att.id}
                    attachment={att}
                    testId={`attachment-image-${att.id}`}
                    className="w-32 h-32 rounded-[10px] object-cover border border-border"
                  />
                ) : isSafeHttpUrl(att.url) ? (
                  <a
                    key={att.id}
                    href={att.url.trim()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-[10px] bg-surface2 border border-border text-label text-foreground hover:bg-secondary"
                  >
                    {att.type === 'doc' ? (
                      <FileText className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <Link2 className="w-4 h-4 text-muted-foreground" />
                    )}
                    <span>{att.title}</span>
                  </a>
                ) : (
                  <span
                    key={att.id}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-[10px] bg-surface2 border border-border text-label text-muted-foreground"
                  >
                    {att.type === 'doc' ? (
                      <FileText className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <Link2 className="w-4 h-4 text-muted-foreground" />
                    )}
                    <span>{att.title}</span>
                  </span>
                )
              )}
            </div>
          </div>
        )}

        {backlinks.length > 0 && (
          <div
            data-testid="backlinks-section"
            className="space-y-2 pt-3 border-t border-border/60"
          >
            <div className="text-eyebrow uppercase text-muted-foreground">
              Referenced By ({backlinks.length})
            </div>
            <div className="flex flex-wrap gap-2">
              {backlinks.map(bl => (
                <button
                  key={bl.id}
                  type="button"
                  data-testid={`backlink-item-${bl.slug}`}
                  onClick={() => navigateTo(`#/note/${encodeURIComponent(bl.slug)}`)}
                  className="px-3 py-1.5 rounded-[8px] bg-surface2 border border-border text-label text-foreground hover:bg-secondary"
                >
                  {bl.meta.title || bl.slug}
                </button>
              ))}
            </div>
          </div>
        )}
      </article>
    </div>
  );
};

export const PracticePreview: React.FC = () => {
  const { books, notes } = usePragya();
  const activeDeltas = useMemo(
    () => notes.filter(n => n.deltaStatus === 'active'),
    [notes]
  );

  return (
    <div data-testid="practice-view" className="py-6 space-y-6">
      <div>
        <h1 className="text-display-l text-foreground tracking-tight">Practice</h1>
        <p className="text-body text-muted-foreground mt-1">
          Active Behavioral Deltas and Takeaway Shuffle.
        </p>
      </div>

      <section data-testid="active-deltas-section" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-eyebrow uppercase text-muted-foreground tracking-wider">
            Active Behavioral Deltas (
            <span data-testid="active-deltas-count" className="num">
              {activeDeltas.length}/5
            </span>
            )
          </h2>
        </div>

        <div className="space-y-3">
          {activeDeltas.map(note => {
            const book = books.find(b => b.id === note.bookId);
            const display = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);
            return (
              <article
                key={note.id}
                data-testid={`delta-card-${note.id}`}
                className="bg-card border border-border rounded-[14px] p-5 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-label font-semibold text-foreground">
                      [[{note.meta.title || note.slug}]]
                    </span>
                    <span className="px-2 py-0.5 text-[11px] rounded bg-surface2 border border-border text-muted-foreground">
                      {book?.title || 'Book'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigateTo(`#/note/${encodeURIComponent(note.slug)}`)}
                    className="text-label font-medium text-foreground hover:underline"
                  >
                    View Note →
                  </button>
                </div>

                <div className="space-y-1">
                  <p className="text-body text-foreground">
                    <strong className="font-semibold">WHEN</strong> {display.triggerBody}
                  </p>
                  <p className="text-body text-foreground font-mono text-[13px]">
                    <strong className="font-semibold">DO</strong> {display.actionBody}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
};
