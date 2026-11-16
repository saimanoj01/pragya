import { toast as sonnerToast } from 'sonner';
import { getToastStyle, type ToastType } from './toastStyle';

export type { ToastType };

export interface ToastAction {
  label: string;
  onClick: () => void;
  testId?: string;
}

export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
}

export function showToast(
  message: string,
  type: ToastType = 'info',
  options?: ToastOptions
) {
  // M4.3: trust the explicit semantic type — never regex-override from message text.
  const style = getToastStyle(type);

  sonnerToast.custom(
    id => (
      <div
        data-testid="notification-toast"
        data-toast-variant={style.variant}
        role={style.variant === 'error' ? 'alert' : 'status'}
        className={`${style.containerClass} py-3 px-5 rounded-2xl border font-medium shadow-xl shadow-black/25 flex items-center gap-3 backdrop-blur-md cursor-pointer`}
        onClick={() => sonnerToast.dismiss(id)}
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
      duration: options?.duration ?? (options?.action ? 6000 : 4000),
    }
  );
}

export { sonnerToast };
