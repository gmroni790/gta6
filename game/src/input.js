// Keyboard and mouse input for Sunset Bay. Keys are tracked by e.code in
// a live Set; edge presses live in a second Set that update() clears once
// per frame, so pressed() is true for exactly one frame per physical
// press. main.js must call update() once per frame, after every system
// has had its chance to read the edges. No pointer lock: the camera
// orbits on right-drag using the mouse deltas.

export function createInput() {
  const keys = new Set();
  const pressedSet = new Set();
  const mouse = { x: 0, y: 0, dx: 0, dy: 0, left: false, right: false, leftPressed: false };

  // Keys whose default action (page scroll) must not fire while playing.
  const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  let lastX = 0;
  let lastY = 0;
  let haveLast = false;

  // Space and arrows keep their native behaviour when a button, link or
  // form control has focus, so menu buttons stay keyboard-usable.
  function isFormControl(el) {
    if (!el || typeof el.closest !== 'function') return false;
    return el.closest('button, a, input, select, textarea, [contenteditable]') !== null;
  }

  function onKeyDown(e) {
    if (PREVENT.has(e.code) && !isFormControl(e.target)) e.preventDefault();
    if (!e.repeat) pressedSet.add(e.code);
    keys.add(e.code);
  }

  function onKeyUp(e) {
    keys.delete(e.code);
  }

  function onBlur() {
    keys.clear();
    mouse.left = false;
    mouse.right = false;
  }

  function onMouseMove(e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (typeof e.movementX === 'number' && typeof e.movementY === 'number') {
      mouse.dx += e.movementX;
      mouse.dy += e.movementY;
    } else if (haveLast) {
      mouse.dx += e.clientX - lastX;
      mouse.dy += e.clientY - lastY;
    }
    lastX = e.clientX;
    lastY = e.clientY;
    haveLast = true;
  }

  function onMouseDown(e) {
    if (e.button === 0) {
      mouse.left = true;
      mouse.leftPressed = true;
    } else if (e.button === 2) {
      mouse.right = true;
    }
  }

  function onMouseUp(e) {
    if (e.button === 0) mouse.left = false;
    else if (e.button === 2) mouse.right = false;
  }

  function onContextMenu(e) {
    // Right-drag orbits the camera; never show the browser menu for it.
    e.preventDefault();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('contextmenu', onContextMenu);

  function pressed(code) {
    return pressedSet.has(code);
  }

  function consumePressed(code) {
    if (pressedSet.has(code)) {
      pressedSet.delete(code);
      return true;
    }
    return false;
  }

  // Movement axes: x is strafe (D positive), y is forward (W positive).
  function axis() {
    const x =
      (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
      (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const y =
      (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
      (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    return { x, y };
  }

  // Called once per frame by main.js, after all readers: clears the
  // per-frame edges and mouse deltas.
  function update() {
    pressedSet.clear();
    mouse.dx = 0;
    mouse.dy = 0;
    mouse.leftPressed = false;
  }

  return { keys, pressed, axis, mouse, consumePressed, update };
}
