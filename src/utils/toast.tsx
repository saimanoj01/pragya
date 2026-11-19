import { toast as sonnerToast } from 'sonner';
import { getToastStyle, type ToastType } from './toastStyle';
import { promoteToastLayer } from './toastLayer';

export type { ToastType };

export interface ToastAction {
  label: string;
  onClick: () => void;
  testId?: string;
}

export interface ToastOptions {
  id?: string | number;
  duration?: number;
  action?: ToastAction;
}

const activeLogicalToastIds = new Map<string | number, string>();
let toastSeq = 0;

export function showToast(
  message: string,
  type: ToastType = 'info',
  options?: ToastOptions
) {
  // CD Batch 6 (D2.4): lift the toast container above any open top-layer `<dialog>`.
  promoteToastLayer();

  // M4.3: trust the explicit semantic type — never regex-override from message text.
  const style = getToastStyle(type);
  const logicalId = options?.id;
  let customToastId: string | undefined;

  if (logicalId !== undefined) {
    const prevSonnerId = activeLogicalToastIds.get(logicalId);
    if (prevSonnerId) {
      sonnerToast.dismiss(prevSonnerId);
    }
    toastSeq += 1;
    customToastId = `${String(logicalId)}-${toastSeq}`;
    activeLogicalToastIds.set(logicalId, customToastId);
  }

  const clearLogicalRef = (sonnerId: string | number) => {
    if (logicalId !== undefined && activeLogicalToastIds.get(logicalId) === String(sonnerId)) {
      activeLogicalToastIds.delete(logicalId);
    }
  };

  sonnerToast.custom(
    id => (
      <div
        data-testid="notification-toast"
        data-toast-variant={style.variant}
        role={style.variant === 'error' ? 'alert' : 'status'}
        className={`${style.containerClass} py-3 px-5 rounded-2xl border font-medium shadow-xl shadow-black/25 flex items-center gap-3 backdrop-blur-md cursor-pointer`}
        onClick={() => {
          clearLogicalRef(id);
          sonnerToast.dismiss(id);
        }}
      >
        <div className={`w-2 h-2 rounded-full shrink-0 ${style.dotClass}`} />
        <span className="text-sm font-semibold">{message}</span>
        {options?.action && (
          <button
            type="button"
            data-testid={options.action.testId || 'toast-action-btn'}
            onClick={e => {
              e.stopPropagation();
              options.action!.onClick();
              clearLogicalRef(id);
              sonnerToast.dismiss(id);
            }}
            className={`ml-1.5 px-2.5 py-1 rounded-lg text-xs font-bold transition-colors shrink-0 ${style.actionClass}`}
          >
            {options.action.label}
          </button>
        )}
      </div>
    ),
    {
      ...(customToastId ? { id: customToastId } : {}),
      duration: options?.duration ?? (options?.action ? 6000 : 4000),
      onDismiss: t => clearLogicalRef(t.id),
      onAutoClose: t => clearLogicalRef(t.id),
    }
  );
}

/**
 * CD C1.2 fix-up (R2): drop every visible toast (e.g. on logout) so an Undo action can
 * never run against the next session's workspace.
 */
export function dismissAllToasts(): void {
  activeLogicalToastIds.clear();
  sonnerToast.dismiss();
}

export { sonnerToast };
