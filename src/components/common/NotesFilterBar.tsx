import React from 'react';
import { Archive, Search, Sparkles, X } from 'lucide-react';
import type { Book } from '../../types/pragya';
import {
  NOTES_SORT_LABELS,
  NOTES_SORTS,
  type NotesFilter,
  type NotesQueryState,
  type NotesSort,
} from '../../utils/notesQuery';
import { BTN_TERTIARY, FIELD_LABEL } from './uiClasses';

export interface NotesFilterCounts {
  all: number;
  toSpar: number;
  atomic: number;
  media: number;
  concepts: number;
}

export interface NotesFilterBarProps {
  qs: NotesQueryState;
  counts: NotesFilterCounts;
  archivedCount: number;
  bookOptions: Book[];
  bookMap: Map<string, Book>;
  announcedCount: number;
  onQueryChange: (q: string) => void;
  onFilterChange: (filter: NotesFilter) => void;
  onBookChange: (bookId: string) => void;
  onSortChange: (sort: NotesSort) => void;
  onToggleTag: (tag: string) => void;
  onClearAll: () => void;
}

function pillClass(active: boolean, withIcon = false): string {
  return `h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 rounded-full text-label font-medium transition-colors num ${
    withIcon ? 'inline-flex items-center gap-1.5 ' : ''
  }whitespace-nowrap ${
    active
      ? 'bg-primary text-primary-foreground'
      : 'bg-surface2 border border-border text-muted-foreground hover:text-foreground'
  }`;
}

/**
 * Search input, filter pills, book/sort selectors, polite result counter, and active filter
 * chips extracted from NotesView.
 */
export const NotesFilterBar: React.FC<NotesFilterBarProps> = ({
  qs,
  counts,
  archivedCount,
  bookOptions,
  bookMap,
  announcedCount,
  onQueryChange,
  onFilterChange,
  onBookChange,
  onSortChange,
  onToggleTag,
  onClearAll,
}) => {
  const { q: query, filter } = qs;

  return (
    <div data-print-hide="true" className="space-y-3">
      <div className="relative">
        <Search className="w-4 h-4 text-muted-foreground absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          enterKeyHint="search"
          aria-label="Search notes"
          data-testid="notes-search-input"
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          placeholder="Search quotes, takeaways, #tags, or authors..."
          className="w-full h-11 pl-10 pr-4 rounded-full bg-card border border-border text-base sm:text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="notes-filter-all"
          onClick={() => onFilterChange('all')}
          className={pillClass(filter === 'all')}
        >
          All ({counts.all})
        </button>

        <button
          type="button"
          data-testid="notes-filter-to-spar"
          onClick={() => onFilterChange('to-spar')}
          className={pillClass(filter === 'to-spar', true)}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>To Spar ({counts.toSpar})</span>
        </button>

        <button
          type="button"
          data-testid="notes-filter-atomic"
          onClick={() => onFilterChange('atomic')}
          className={pillClass(filter === 'atomic')}
        >
          Atomic ({counts.atomic})
        </button>

        <button
          type="button"
          data-testid="notes-filter-media"
          onClick={() => onFilterChange('media')}
          className={pillClass(filter === 'media')}
        >
          Has Media ({counts.media})
        </button>

        <button
          type="button"
          data-testid="notes-filter-concepts"
          onClick={() => onFilterChange('concepts')}
          className={pillClass(filter === 'concepts')}
        >
          [[Concepts]] ({counts.concepts})
        </button>

        {(archivedCount > 0 || filter === 'archived') && (
          <button
            type="button"
            data-testid="notes-filter-archived"
            onClick={() => onFilterChange('archived')}
            className={pillClass(filter === 'archived', true)}
          >
            <Archive className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Archived ({archivedCount})</span>
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span className={FIELD_LABEL}>Book</span>
          <select
            data-testid="notes-book-filter"
            value={qs.book}
            onChange={e => onBookChange(e.target.value)}
            className="h-11 sm:h-9 px-2.5 rounded-[10px] bg-background border border-input text-base sm:text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 max-w-[220px]"
          >
            <option value="">All books</option>
            {bookOptions.map(b => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className={FIELD_LABEL}>Sort</span>
          <select
            data-testid="notes-sort-select"
            value={qs.sort}
            onChange={e => onSortChange(e.target.value as NotesSort)}
            className="h-11 sm:h-9 px-2.5 rounded-[10px] bg-background border border-input text-base sm:text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            {NOTES_SORTS.map(sv => (
              <option key={sv} value={sv}>
                {NOTES_SORT_LABELS[sv]}
              </option>
            ))}
          </select>
        </label>
        <span
          data-testid="notes-result-count"
          role="status"
          aria-live="polite"
          className="ml-auto text-label text-muted-foreground num"
        >
          {announcedCount} {announcedCount === 1 ? 'note' : 'notes'}
        </span>
      </div>

      {(qs.tags.length > 0 || qs.book) && (
        <div data-testid="notes-active-filters" className="flex flex-wrap items-center gap-2">
          <span className="text-label text-muted-foreground">Filtered by:</span>
          {qs.tags.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 pl-2.5 pr-1 sm:pr-2.5 py-1 rounded-full bg-surface2 border border-border text-label text-foreground"
            >
              {tag}
              <button
                type="button"
                aria-label={`Remove filter ${tag}`}
                onClick={() => onToggleTag(tag)}
                className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 -my-2 -mr-1 sm:m-0 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </span>
          ))}
          {qs.book && (
            <span className="inline-flex items-center gap-1 pl-2.5 pr-1 sm:pr-2.5 py-1 rounded-full bg-surface2 border border-border text-label text-foreground">
              {bookMap.get(qs.book)?.title || 'Book'}
              <button
                type="button"
                aria-label={`Remove filter ${bookMap.get(qs.book)?.title || 'Book'}`}
                onClick={() => onBookChange('')}
                className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 -my-2 -mr-1 sm:m-0 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </span>
          )}
          <button
            type="button"
            data-testid="notes-clear-filters-btn"
            onClick={onClearAll}
            className={BTN_TERTIARY}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
};
