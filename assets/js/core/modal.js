// Модальные окна на <dialog> с анимацией открытия/закрытия.
// Разметка:
//   <dialog class="modal [wide]">
//     <div class="modal-frame"><div class="modal-card">
//       <button class="modal-close" type="button" data-close aria-label="Закрыть">✕</button>
//       ...
//     </div></div>
//   </dialog>
import { motion } from "./util.js";
import { setCursorSuspended } from "./fx.js";

/**
 * Подключает поведение к <dialog>: Esc, клик по фону (нажали и отпустили на фоне),
 * кнопки [data-close], анимация закрытия, системный курсор внутри окна.
 * @returns {{ open(): void, close(): void, el: HTMLDialogElement }}
 */
export function setupModal(dlg, { onOpen, onClose } = {}) {
  let pressedOnBackdrop = false;
  let closeTimer = 0;

  function open() {
    if (dlg.open) {
      // открыли снова, пока шла анимация закрытия, — отменяем закрытие
      if (dlg.classList.contains("is-closing")) {
        clearTimeout(closeTimer);
        dlg.classList.remove("is-closing");
      }
      return;
    }
    onOpen?.();
    dlg.showModal();
    setCursorSuspended(true);
  }

  function close() {
    if (!dlg.open || dlg.classList.contains("is-closing")) return;
    if (!motion) return dlg.close();
    dlg.classList.add("is-closing");
    closeTimer = setTimeout(() => {
      dlg.classList.remove("is-closing");
      dlg.close();
    }, 280);
  }

  dlg.addEventListener("close", () => {
    if (!document.querySelector("dialog[open]")) setCursorSuspended(false);
    onClose?.();
  });
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener("pointerdown", (e) => { pressedOnBackdrop = e.target === dlg; });
  dlg.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) close();
    else if (pressedOnBackdrop && e.target === dlg) close();
    pressedOnBackdrop = false;
  });

  return { open, close, el: dlg };
}

/** Перезапускает анимацию «тряски» у карточки окна (ошибка в форме). */
export function shake(card) {
  card.classList.remove("shake");
  void card.offsetWidth;
  card.classList.add("shake");
}
