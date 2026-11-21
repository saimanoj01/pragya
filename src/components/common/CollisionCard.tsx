import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Link2, RefreshCw, Sparkles, X } from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { usePragyaActions } from '../../context/PragyaContext';
import { describeSyncError } from '../../utils/apiErrors';
import {
  readSkippedCollisionKeys,
  selectDailyCollisionPair,
  skipCollisionPairToday,
} from '../../utils/crossBookSynthesis';
import { BRIDGE_NOTE_MAX } from '../../utils/metaCodecs';
import { navigateTo } from '../../utils/navigation';
import { noteHref } from '../../utils/noteVisibility';
import { formatPosDisplay } from '../../utils/spoilerMath';
import { showToast } from '../../utils/toast';
import { BTN_PRIMARY, BTN_SECONDARY, BTN_TERTIARY, EYEBROW, INPUT } from './uiClasses';

export interface CollisionCardProps {
  notes: readonly Note[];
  books: readonly Book[];
  todayDate: string;
}

/**
 * v2: deterministic daily "Spark a Connection" two-note pair in PracticeView.
 * Offers one-tap atomic bidirectional linking (relatedSlugs + optional 1-line bridgeNote)
 * with compensating Undo, Different Pair cycling, and Skip Today.
 */
export const CollisionCard: React.FC<CollisionCardProps> = ({ notes, books, todayDate }) => {
  const { saveNoteBridge, restoreNoteBridge } = usePragyaActions();

  const [seedOffset, setSeedOffset] = useState(0);
  const [skippedKeys, setSkippedKeys] = useState<Set<string>>(() =>
    readSkippedCollisionKeys(todayDate)
  );
  const [linkingOpen, setLinkingOpen] = useState(false);
  const [whyDraft, setWhyDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const linkBtnRef = useRef<HTMLButtonElement | null>(null);
  const whyInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setSkippedKeys(readSkippedCollisionKeys(todayDate));
    setSeedOffset(0);
  }, [todayDate]);

  const pair = useMemo(
    () =>
      selectDailyCollisionPair(notes, books, todayDate, {
        seedOffset,
        skippedKeys,
      }),
    [books, notes, seedOffset, skippedKeys, todayDate]
  );

  const activePairKey = pair?.pairKey ?? '';
  useEffect(() => {
    setLinkingOpen(false);
    setWhyDraft('');
  }, [activePairKey]);

  useEffect(() => {
    if (linkingOpen) whyInputRef.current?.focus();
  }, [linkingOpen]);

  if (!pair) return null;

  const closeLinkForm = (restoreFocus = false) => {
    setLinkingOpen(false);
    setWhyDraft('');
    if (restoreFocus) {
      requestAnimationFrame(() => linkBtnRef.current?.focus());
    }
  };

  const handleLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const res = await saveNoteBridge(pair.noteA.id, pair.noteB.id, {
        mode: 'link',
        bidirectional: true,
        why: whyDraft.trim() || undefined,
      });
      closeLinkForm(false);
      if (res.changed) {
        showToast('Notes linked as a cross-book bridge.', 'success', {
          action: res.undo
            ? {
                label: 'Undo',
                testId: 'toast-undo-btn',
                onClick: () => {
                  void restoreNoteBridge(res.undo!)
                    .then(() => showToast('Bridge undone.', 'info'))
                    .catch(err =>
                      showToast(describeSyncError(err, 'Failed to undo bridge'), 'error')
                    );
                },
              }
            : undefined,
        });
      }
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to link notes'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSkipToday = () => {
    const next = skipCollisionPairToday(pair.pairKey, todayDate);
    setSkippedKeys(new Set(next));
    closeLinkForm(false);
  };

  const handleNextPair = () => {
    setSeedOffset(prev => prev + 1);
    closeLinkForm(false);
  };

  const cards = [
    { note: pair.noteA, book: pair.bookA, slot: 'a' },
    { note: pair.noteB, book: pair.bookB, slot: 'b' },
  ] as const;

  return (
    <section data-testid="collision-card-section" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={`inline-flex items-center gap-2 ${EYEBROW}`}>
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Spark a Connection</span>
        </div>
        <span className="text-label text-muted-foreground">
          Any connection between these two?
        </span>
      </div>

      <div className="bg-card border border-border rounded-[14px] p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {cards.map(({ note, book, slot }) => (
            <article
              key={note.id}
              data-testid={`collision-note-${slot}`}
              className="rounded-[12px] bg-surface2/50 border border-border p-3.5 flex flex-col justify-between gap-2.5 min-w-0"
            >
              <div className="space-y-1.5 min-w-0">
                <div className="flex items-center justify-between gap-2 text-label text-muted-foreground">
                  <span className="font-medium text-foreground truncate">{book.title}</span>
                  <span className="num shrink-0 text-[11px]">
                    {formatPosDisplay(Number(note.pos) || 0, book.posUnit)}
                  </span>
                </div>
                {note.meta?.title && (
                  <h3 className="text-heading text-foreground line-clamp-2">{note.meta.title}</h3>
                )}
                {note.quote && (
                  <blockquote className="pl-2.5 border-l-2 border-border italic text-label text-muted-foreground line-clamp-2">
                    &ldquo;{note.quote}&rdquo;
                  </blockquote>
                )}
                {note.takeaway && (
                  <p className="text-body text-foreground line-clamp-3">{note.takeaway}</p>
                )}
              </div>
              <div className="pt-2 border-t border-border/50 flex justify-end">
                <button
                  type="button"
                  onClick={() => navigateTo(noteHref(note, book))}
                  className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 px-1 sm:px-0 inline-flex items-center justify-center gap-0.5 text-label text-muted-foreground hover:text-foreground"
                >
                  <span>Open</span>
                  <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </div>

        {linkingOpen ? (
          <form
            onSubmit={e => void handleLink(e)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeLinkForm(true);
              }
            }}
            data-testid="collision-link-form"
            className="print:hidden pt-2 border-t border-border/60 space-y-2.5"
          >
            <input
              ref={whyInputRef}
              type="text"
              enterKeyHint="done"
              maxLength={BRIDGE_NOTE_MAX}
              data-testid="collision-why-input"
              aria-label="Why do these two notes connect? (optional)"
              value={whyDraft}
              onChange={e => setWhyDraft(e.target.value)}
              placeholder="Why do these connect? (optional — your note prose stays untouched)"
              className={INPUT}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => closeLinkForm(true)}
                className={BTN_TERTIARY}
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="collision-confirm-link-btn"
                disabled={saving}
                className={BTN_PRIMARY}
              >
                <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{saving ? 'Linking…' : 'Confirm Link'}</span>
              </button>
            </div>
          </form>
        ) : (
          <div className="print:hidden pt-2 border-t border-border/60 flex flex-wrap items-center justify-between gap-2">
            <button
              ref={linkBtnRef}
              type="button"
              data-testid="collision-link-btn"
              onClick={() => setLinkingOpen(true)}
              className={BTN_SECONDARY}
            >
              <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Link Notes</span>
            </button>

            <div className="flex items-center gap-2">
              {pair.totalCandidates > 1 && (
                <button
                  type="button"
                  data-testid="collision-next-btn"
                  onClick={handleNextPair}
                  className={BTN_TERTIARY}
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Different Pair</span>
                </button>
              )}
              <button
                type="button"
                data-testid="collision-skip-btn"
                onClick={handleSkipToday}
                className={BTN_TERTIARY}
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Skip Today</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
