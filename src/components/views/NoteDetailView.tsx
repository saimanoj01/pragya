import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Edit3,
  Eye,
  FileText,
  Layers,
  Link2,
  Lock,
  Plus,
  Sparkles,
  Unlock,
} from 'lucide-react';
import type { Attachment, Note } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { isEditableElement } from '../../hooks/useKeyboardShortcuts';
import { getRenderableAttachments } from '../../utils/metaCodecs';
import { formatWhenDoDisplay } from '../../utils/deltaFormat';
import { isSafeHttpUrl, navigateTo, replaceHash } from '../../utils/navigation';
import {
  formatPosDisplay,
  isSealedPrediction,
  isUnlockedPrediction,
} from '../../utils/spoilerMath';
import { computeBacklinks, extractNoteWikilinks } from '../../utils/wikilinks';
import {
  NOTE_REVEALED_ANNOUNCEMENT,
  getNoteDetailVisibility,
  isShielded,
  noteHref,
  resolveNoteRef,
  shieldedNoteLabel,
} from '../../utils/noteVisibility';
import { DriveImage } from '../common/DriveImage';
import { ImageLightbox } from '../modals/ImageLightbox';

export interface NoteDetailViewProps {
  noteSlug: string;
  onOpenEdit: (note: Note) => void;
  onOpenDeepen: (note: Note) => void;
  onOpenCapture: () => void;
}

export const NoteDetailView: React.FC<NoteDetailViewProps> = ({
  noteSlug,
  onOpenEdit,
  onOpenDeepen,
  onOpenCapture,
}) => {
  const { books, notes } = usePragya();
  const [lightboxAttachment, setLightboxAttachment] = useState<
    Extract<Attachment, { type: 'image' }> | null
  >(null);

  // Batch 4 decision: the route segment is a slug or (for shielded notes) the note id.
  const note = useMemo(() => resolveNoteRef(notes, noteSlug) || null, [notes, noteSlug]);
  const book = useMemo(
    () => (note ? books.find(b => b.id === note.bookId) || null : null),
    [books, note]
  );
  const bookById = useMemo(() => new Map(books.map(b => [b.id, b] as const)), [books]);

  // B2.1: local reveal state, keyed to the note id so it resets whenever the note changes
  // (and survives the uuid → slug URL swap on reveal).
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Reset during render (not in an effect) when another note is shown, so navigating
  // A (revealed) → B → A re-shields A without a frame of revealed content.
  const currentNoteId = note?.id ?? null;
  const [revealScopeId, setRevealScopeId] = useState<string | null>(currentNoteId);
  if (revealScopeId !== currentNoteId) {
    setRevealScopeId(currentNoteId);
    setRevealedId(null);
  }
  const revealed = revealScopeId === currentNoteId && Boolean(note) && revealedId === note?.id;
  const shielded = note ? isShielded(note, book, revealed) : false;

  const revealNote = useCallback(() => {
    if (!note) return;
    setRevealedId(note.id);
    setAnnouncement(NOTE_REVEALED_ANNOUNCEMENT);
    // Batch 4 decision: once revealed, show the canonical slug URL (no history entry).
    if (noteSlug !== note.slug) replaceHash(`#/note/${encodeURIComponent(note.slug)}`);
    requestAnimationFrame(() => headingRef.current?.focus());
  }, [note, noteSlug]);

  useEffect(() => {
    setAnnouncement('');
  }, [noteSlug]);

  const existingSlugSet = useMemo(() => new Set(notes.map(n => n.slug)), [notes]);
  const wikilinks = useMemo(() => (note ? extractNoteWikilinks(note) : []), [note]);
  const backlinks = useMemo(() => (note ? computeBacklinks(note.slug, notes) : []), [note, notes]);

  const imageAttachments = useMemo(
    () =>
      getRenderableAttachments(note?.meta).filter(
        (a): a is Extract<Attachment, { type: 'image' }> => a.type === 'image'
      ),
    [note]
  );

  const primarySafeExternalUrl = useMemo(() => {
    if (!note) return null;
    for (const att of getRenderableAttachments(note.meta)) {
      if (att.type !== 'image' && isSafeHttpUrl(att.url)) {
        return att.url.trim();
      }
    }
    for (const link of note.meta?.links || []) {
      if (isSafeHttpUrl(link)) {
        return link.trim();
      }
    }
    if (book && isSafeHttpUrl(book.docUrl)) {
      return book.docUrl.trim();
    }
    return null;
  }, [book, note]);

  useEffect(() => {
    setLightboxAttachment(null);
  }, [noteSlug]);

  useEffect(() => {
    if (!note) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableElement(e.target)) return;
      if (document.querySelector('[data-popover="true"]')) return;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const topDialog = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
      const openLightboxEl = document.querySelector('[data-testid="image-lightbox"]');
      if (openLightboxEl) {
        if (topDialog && topDialog !== openLightboxEl) return;
        if (e.key === ' ') {
          e.preventDefault();
          setLightboxAttachment(null);
        }
        return;
      }
      if (dialogs.length > 0) return;
      const target = e.target as HTMLElement | null;
      if (e.key === ' ' && target && target.closest('button, a, [role="button"]')) return;

      if (shielded) {
        // B2.1: Space reveals (priority over the lightbox); E / D / O are no-ops.
        if (e.key === ' ') {
          e.preventDefault();
          revealNote();
        }
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'e') {
        e.preventDefault();
        onOpenEdit(note);
      } else if (key === 'd') {
        e.preventDefault();
        onOpenDeepen(note);
      } else if (key === 'o' && primarySafeExternalUrl) {
        e.preventDefault();
        window.open(primarySafeExternalUrl, '_blank', 'noopener,noreferrer');
      } else if (e.key === ' ' && imageAttachments.length > 0) {
        e.preventDefault();
        setLightboxAttachment(imageAttachments[0]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [imageAttachments, note, onOpenDeepen, onOpenEdit, primarySafeExternalUrl, shielded, revealNote]);

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

        <div className="bg-card border border-border rounded-[14px] p-6 space-y-4">
          <div className="space-y-1">
            <h1 className="text-title text-foreground">
              Concept <span className="font-mono">[[{noteSlug}]]</span> not found
            </h1>
            <p className="text-body text-muted-foreground">
              No note uses this slug yet. You can capture a new note and link it later.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenCapture}
            className="h-9 px-4 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Capture Note for [[{noteSlug}]]</span>
          </button>
        </div>
      </div>
    );
  }

  const visibility = getNoteDetailVisibility(note, book, revealed);
  const deltaDisplay = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);
  const sealedPrediction = isSealedPrediction(note, book || undefined);
  const unlockedPrediction = isUnlockedPrediction(note, book || undefined);
  const hasDelta = Boolean(
    deltaDisplay.triggerBody || deltaDisplay.actionBody || note.deltaStatus !== 'none'
  );

  return (
    <div data-testid="note-detail-view" className="py-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          data-testid="back-to-notes-btn"
          onClick={() => navigateTo('#/notes')}
          className="inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Notes</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="edit-note-btn"
            onClick={() => onOpenEdit(note)}
            disabled={visibility.editDisabled}
            title={visibility.editTooltip}
            aria-describedby={visibility.shielded ? 'note-detail-shield-text' : undefined}
            className="h-9 px-3 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-label font-medium text-foreground inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Edit (E)</span>
          </button>

          <button
            type="button"
            data-testid="deepen-note-btn"
            onClick={() => onOpenDeepen(note)}
            disabled={visibility.editDisabled}
            title={visibility.editTooltip}
            aria-describedby={visibility.shielded ? 'note-detail-shield-text' : undefined}
            className="h-9 px-3.5 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Deepen (D)</span>
          </button>
        </div>
      </div>

      <article className="bg-card border border-border rounded-[14px] p-5 sm:p-6 space-y-5">
        <div className="space-y-2">
          <div className="text-label text-muted-foreground flex flex-wrap items-center gap-2">
            {book ? (
              <button
                type="button"
                onClick={() => navigateTo(`#/book/${encodeURIComponent(book.id)}`)}
                className="font-semibold text-foreground hover:underline"
              >
                {book.title}
              </button>
            ) : (
              <span className="font-semibold text-foreground">Book</span>
            )}
            <span>·</span>
            <span className="num">{formatPosDisplay(note.pos, book?.posUnit || 'page')}</span>
            <span>·</span>
            <span className="uppercase text-[11px] font-semibold px-2 py-0.5 rounded bg-surface2 border border-border text-foreground">
              {note.status}
            </span>
            <span className="text-[11px] uppercase text-faint">via {note.source}</span>
            {sealedPrediction && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-surface2 border border-border text-foreground">
                <Lock className="w-3 h-3" />
                <span>Sealed Prediction</span>
              </span>
            )}
            {unlockedPrediction && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-positive/15 border border-positive/30 text-positive">
                <Unlock className="w-3 h-3" />
                <span>Unlocked Prediction</span>
              </span>
            )}
          </div>

          <h1
            ref={headingRef}
            tabIndex={-1}
            data-testid="note-detail-title"
            className={`text-display-l tracking-tight outline-none ${
              visibility.shielded ? 'text-muted-foreground' : 'text-foreground'
            }`}
          >
            {visibility.heading}
          </h1>
          {visibility.showContent && (
            <div className="text-label font-mono text-muted-foreground">[[{note.slug}]]</div>
          )}
          <span role="status" aria-live="polite" className="sr-only">
            {announcement}
          </span>
        </div>

        {visibility.shielded && (
          <div
            data-testid={`spoiler-shield-${note.slug}`}
            role="region"
            aria-label="Spoiler shield"
            className="rounded-[12px] bg-surface2/70 border border-border p-5 text-center space-y-2.5"
          >
            <div className="inline-flex items-center gap-1.5 text-body font-semibold text-foreground">
              <AlertTriangle className="w-4 h-4 text-warning" aria-hidden="true" />
              <span>Spoiler Shield</span>
            </div>
            <p id="note-detail-shield-text" className="text-label text-muted-foreground num">
              Page/Pos {note.pos} &gt; Current {book?.currentPos ?? 0} — Click or press Space to reveal
            </p>
            <button
              type="button"
              data-testid={`spoiler-reveal-btn-${note.slug}`}
              onClick={revealNote}
              className="h-9 px-4 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 transition-opacity inline-flex items-center gap-1.5"
            >
              <Eye className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Reveal Note (or Space)</span>
            </button>
          </div>
        )}

        {visibility.showContent && (
          <>

        {/* Socratic Recovery Banner */}
        {note.status === 'in-reflection' &&
          note.meta.socraticQuestions &&
          note.meta.socraticQuestions.length > 0 && (
            <div
              data-testid="socratic-recovery-banner"
              className="rounded-[12px] bg-surface2 border border-border p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-label font-semibold text-warning uppercase tracking-wide">
                  <Sparkles className="w-4 h-4 shrink-0" />
                  <span>Socratic Reflection Prompts</span>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenDeepen(note)}
                  className="h-8 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 whitespace-nowrap"
                >
                  Continue Deepening →
                </button>
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
            <p className="text-body text-foreground whitespace-pre-wrap">{note.takeaway}</p>
          </div>
        )}

        {wikilinks.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-eyebrow uppercase text-muted-foreground">Related Concepts:</span>
            {wikilinks.map(slug => {
              const exists = existingSlugSet.has(slug);
              return (
                <button
                  key={slug}
                  type="button"
                  data-testid={`wikilink-chip-${slug}`}
                  onClick={() => navigateTo(`#/note/${encodeURIComponent(slug)}`)}
                  className={`px-2.5 py-1 rounded-[8px] border text-label font-mono transition-colors ${
                    exists
                      ? 'bg-surface2 border-border text-foreground hover:bg-secondary'
                      : 'bg-background border-dashed border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  [[{slug}]]{!exists ? ' (missing)' : ''}
                </button>
              );
            })}
          </div>
        )}

        {note.contextMechanism && (
          <div className="space-y-1 pt-2 border-t border-border/60">
            <div className="text-eyebrow uppercase text-muted-foreground">
              Context &amp; Mechanism
            </div>
            <p className="text-body text-foreground whitespace-pre-wrap">
              {note.contextMechanism}
            </p>
          </div>
        )}

        {hasDelta && (
          <div className="rounded-[12px] bg-surface2/70 border border-border p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
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
            <p className="text-body text-foreground whitespace-pre-wrap">{note.critique}</p>
          </div>
        )}

        {getRenderableAttachments(note.meta).length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border/60">
            <div className="text-eyebrow uppercase text-muted-foreground">Attachments</div>
            <div className="flex flex-wrap gap-3">
              {getRenderableAttachments(note.meta).map(att =>
                att.type === 'image' ? (
                  <DriveImage
                    key={att.id}
                    attachment={att}
                    testId={`attachment-image-${att.id}`}
                    onClick={() => setLightboxAttachment(att)}
                    className="w-32 h-32 rounded-[10px] object-cover border border-border hover:opacity-90 transition-opacity"
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
                    <Link2 className="w-4 h-4" />
                    <span>{att.title}</span>
                  </span>
                )
              )}
            </div>
          </div>
        )}

        {Array.isArray(note.tags) && note.tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/60">
            {note.tags.map(tag => (
              <span key={tag} className="text-label text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
        )}
          </>
        )}

        {visibility.showBacklinks && backlinks.length > 0 && (
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
                  onClick={() => navigateTo(noteHref(bl, bookById.get(bl.bookId)))}
                  className="px-3 py-1.5 rounded-[8px] bg-surface2 border border-border text-label text-foreground hover:bg-secondary"
                >
                  {isShielded(bl, bookById.get(bl.bookId))
                    ? shieldedNoteLabel(bl, bookById.get(bl.bookId))
                    : bl.meta?.title || bl.slug}
                </button>
              ))}
            </div>
          </div>
        )}
      </article>

      <ImageLightbox
        attachment={lightboxAttachment}
        onClose={() => setLightboxAttachment(null)}
      />
    </div>
  );
};
