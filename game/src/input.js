// Keyboard and mouse input. Held keys give continuous axes (move / drive) and booleans (run);
// one-shot presses are queued as bit flags and taken once by the loop, so a press between two
// frames is never lost and never counted twice. The mouse position is tracked in CSS pixels
// relative to the canvas, and the renderer converts it to world coordinates through the camera.

export const ACTION_CONFIRM = 1;
export const ACTION_PAUSE = 2;
export const ACTION_ENTER = 4;
export const ACTION_MUTE = 8;
export const ACTION_WEAPON = 16;
export const ACTION_CONTINUE = 32;

const CONFIRM = new Set(['Space', 'Enter']);
const CONTINUE = new Set(['KeyC']);
const PAUSE = new Set(['KeyP', 'Escape']);
const ENTER_CAR = new Set(['KeyE', 'KeyF']);
const MUTE = new Set(['KeyM']);
const WEAPON = new Set(['KeyQ', 'Digit1', 'Digit2']);
const HELD = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'KeyA', 'KeyD', 'KeyW', 'KeyS', 'ShiftLeft', 'ShiftRight', 'KeyJ', 'Space',
]);

export function createInput(target) {
  const keys = new Set();
  let actions = 0;
  const mouse = { x: 0, y: 0, down: false };

  window.addEventListener('keydown', (event) => {
    if (CONFIRM.has(event.code)) {
      if (!event.repeat) actions |= ACTION_CONFIRM;
    } else if (PAUSE.has(event.code)) {
      if (!event.repeat) actions |= ACTION_PAUSE;
    } else if (ENTER_CAR.has(event.code)) {
      if (!event.repeat) actions |= ACTION_ENTER;
    } else if (MUTE.has(event.code)) {
      if (!event.repeat) actions |= ACTION_MUTE;
    } else if (WEAPON.has(event.code)) {
      if (!event.repeat) actions |= ACTION_WEAPON;
    } else if (CONTINUE.has(event.code)) {
      if (!event.repeat) actions |= ACTION_CONTINUE;
    }
    if (HELD.has(event.code) || CONFIRM.has(event.code)) keys.add(event.code);
    if (HELD.has(event.code) || CONFIRM.has(event.code) || PAUSE.has(event.code)) event.preventDefault();
  });
  window.addEventListener('keyup', (event) => {
    keys.delete(event.code);
  });
  // A key released while the tab is hidden never sends keyup: let go of everything on blur.
  window.addEventListener('blur', () => {
    keys.clear();
    mouse.down = false;
  });
  target.addEventListener('pointermove', (event) => {
    const rect = target.getBoundingClientRect();
    mouse.x = event.clientX - rect.left;
    mouse.y = event.clientY - rect.top;
  });
  target.addEventListener('pointerdown', (event) => {
    mouse.down = true;
    const rect = target.getBoundingClientRect();
    mouse.x = event.clientX - rect.left;
    mouse.y = event.clientY - rect.top;
    actions |= ACTION_CONFIRM;
  });
  window.addEventListener('pointerup', () => {
    mouse.down = false;
  });

  return {
    /** Horizontal axis: -1 left, 1 right, 0 for neither or both. */
    axisX() {
      return ((keys.has('ArrowRight') || keys.has('KeyD')) ? 1 : 0) - ((keys.has('ArrowLeft') || keys.has('KeyA')) ? 1 : 0);
    },
    /** Vertical axis: -1 up, 1 down. Driving reads this as throttle/brake. */
    axisY() {
      return ((keys.has('ArrowDown') || keys.has('KeyS')) ? 1 : 0) - ((keys.has('ArrowUp') || keys.has('KeyW')) ? 1 : 0);
    },
    run() {
      return keys.has('ShiftLeft') || keys.has('ShiftRight');
    },
    /** Attack held: mouse button, J, or Space. */
    attack() {
      return mouse.down || keys.has('KeyJ') || keys.has('Space');
    },
    mouse,
    /** The one-shot presses since the last call, as ACTION_* flags. */
    takeActions() {
      const taken = actions;
      actions = 0;
      return taken;
    },
  };
}
