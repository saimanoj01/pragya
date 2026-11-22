import React from 'react';
import { Copy } from 'lucide-react';
import { CHAPTER_MAX_LENGTH } from '../../utils/chapterFormat';
import { FIELD_LABEL, INPUT } from './uiClasses';

export interface WordCaptureFieldsProps {
  baseId: string;
  word: string;
  onWordChange: (next: string) => void;
  wordInputRef: React.RefObject<HTMLInputElement>;
  chapterValue: string;
  onChapterChange: (next: string) => void;
  chapterHintText?: string;
  quote: string;
  onQuoteChange: (next: string) => void;
  meaning: string;
  onMeaningChange: (next: string) => void;
  example: string;
  onExampleChange: (next: string) => void;
  tagsRaw: string;
  onTagsChange: (next: string) => void;
  onCopyLookupPrompt: () => void;
}

export const WordCaptureFields: React.FC<WordCaptureFieldsProps> = ({
  baseId,
  word,
  onWordChange,
  wordInputRef,
  chapterValue,
  onChapterChange,
  chapterHintText,
  quote,
  onQuoteChange,
  meaning,
  onMeaningChange,
  example,
  onExampleChange,
  tagsRaw,
  onTagsChange,
  onCopyLookupPrompt,
}) => {
  const wordFieldId = `${baseId}-word`;
  const chapterFieldId = `${baseId}-word-chapter`;
  const quoteFieldId = `${baseId}-word-quote`;
  const meaningFieldId = `${baseId}-meaning`;
  const exampleFieldId = `${baseId}-example`;
  const tagsFieldId = `${baseId}-word-tags`;

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={wordFieldId} className={FIELD_LABEL}>
            Word <span className="text-negative">*</span>
          </label>
          <button
            type="button"
            data-testid="capture-copy-lookup-prompt"
            disabled={!word.trim()}
            onClick={onCopyLookupPrompt}
            className="inline-flex items-center gap-1 text-label font-medium text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
          >
            <Copy className="w-3 h-3" />
            <span>Copy lookup prompt</span>
          </button>
        </div>
        <input
          ref={wordInputRef}
          id={wordFieldId}
          type="text"
          maxLength={120}
          autoComplete="off"
          data-testid="capture-word-input"
          value={word}
          onChange={e => onWordChange(e.target.value)}
          placeholder="e.g. oscillation, pandemonium, liminal"
          className={INPUT}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={chapterFieldId} className={FIELD_LABEL}>
          Chapter / Story (Optional)
        </label>
        <input
          id={chapterFieldId}
          type="text"
          maxLength={CHAPTER_MAX_LENGTH}
          autoComplete="off"
          data-testid="capture-chapter-input"
          value={chapterValue}
          placeholder="e.g. Ch. 3: Run · or a story title"
          onChange={e => onChapterChange(e.target.value)}
          className={INPUT}
        />
        {chapterHintText && (
          <p data-testid="capture-chapter-hint" className="text-label text-faint">
            {chapterHintText}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor={quoteFieldId} className={FIELD_LABEL}>
          Scene / Passage (Optional)
        </label>
        <textarea
          id={quoteFieldId}
          rows={2}
          data-testid="capture-quote-input"
          value={quote}
          onChange={e => onQuoteChange(e.target.value)}
          placeholder="The sentence or moment where you met this word..."
          className="w-full p-3 rounded-[10px] bg-surface2/50 border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={meaningFieldId} className={FIELD_LABEL}>
          Meaning (Optional)
        </label>
        <textarea
          id={meaningFieldId}
          rows={2}
          maxLength={1200}
          data-testid="capture-word-meaning-input"
          value={meaning}
          onChange={e => {
            onMeaningChange(e.target.value);
            e.currentTarget.style.height = 'auto';
            e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
          }}
          placeholder="Short sense in your words — or enrich later"
          className="w-full p-3 rounded-[10px] bg-surface2/50 border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={exampleFieldId} className={FIELD_LABEL}>
          My Example (Optional)
        </label>
        <input
          id={exampleFieldId}
          type="text"
          maxLength={400}
          data-testid="capture-word-example-input"
          value={example}
          onChange={e => onExampleChange(e.target.value)}
          placeholder="One sentence using it in your life"
          className={INPUT}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={tagsFieldId} className={FIELD_LABEL}>
          Tags (CSV · #vocabulary added automatically)
        </label>
        <input
          id={tagsFieldId}
          type="text"
          data-testid="capture-tags-input"
          value={tagsRaw}
          onChange={e => onTagsChange(e.target.value)}
          placeholder="#systems, #rhetoric"
          className={INPUT}
        />
      </div>
    </>
  );
};
