import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

/* =========================================================
   GLOBAL STATE
========================================================= */
const GAME = {
  mode: 'medium',
  platform: 'pc', // 'pc' or 'android'
  grandmanEnabled: true,
  ladyEnabled: false,
  sensitivity: 1.0,
  running: false,
  mobileActive: false, // android equivalent of controls.isLocked (no pointer lock on touch)
  inventory: [],
  hasLaunchKey: false,
  hasMainDoorKey: false,
  mainDoorOpen: false,
  safeUnlocked: false,
  boxOpened: false,
  won: false,
  floor: 0, // 0 = ground floor, 1 = upper floor
};

// Virtual joystick vector (android only), x = strafe -1..1, y = forward(-1)/back(1)
const joyVec = { x:0, y:0 };

// Grandma's chase speed increased 10% across all active difficulties.
const DIFFICULTY = {
  practice: { speed:0,    hearing:0,  vision:0,  sprintMult:0,   active:false, wake:0,   react:0 },
  easy:     { speed:2.42, hearing:9,  vision:11, sprintMult:1.3, active:true,  wake:5.0, react:1.0 },
  medium:   { speed:3.19, hearing:12, vision:14, sprintMult:1.5, active:true,  wake:5.5, react:0.7 },
  hard:     { speed:3.96, hearing:15, vision:17, sprintMult:1.7, active:true,  wake:6.0, react:0.5 },
  extreme:  { speed:4.84, hearing:19, vision:21, sprintMult:2.0, active:true,  wake:7.0, react:0.25, oneShot:true },
};

/* =========================================================
   MENU LOGIC now lives in index.html (plain script, no Three.js dependency).
   This module exports startGame(config) which index.html calls after
   dynamically importing this file.
========================================================= */
document.getElementById('retryBtn').addEventListener('click', ()=>location.reload());
document.getElementById('menuBtn').addEventListener('click', ()=>location.reload());

/* =========================================================
   AUDIO ENGINE (fully procedural — no external files needed)
========================================================= */
const AUDIO = { ctx:null, muted:false, master:null, droneNodes:[], heartbeatOn:false, footTimer:0 };

function initAudio(){
  AUDIO.ctx = new (window.AudioContext || window.webkitAudioContext)();
  AUDIO.master = AUDIO.ctx.createGain();
  AUDIO.master.gain.value = 0.5;
  AUDIO.master.connect(AUDIO.ctx.destination);
  startAmbientDrone();
}

function startAmbientDrone(){
  const ctx = AUDIO.ctx;
  const freqs = [55, 82.4, 110]; // low ominous drone
  freqs.forEach((f,i)=>{
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const gain = ctx.createGain();
    gain.gain.value = 0.03 + i*0.01;
    osc.connect(gain).connect(AUDIO.master);
    osc.start();
    AUDIO.droneNodes.push(osc);
  });
  // slow LFO wobble for unease
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.07;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 6;
  lfo.connect(lfoGain);
  lfoGain.connect(AUDIO.droneNodes[0].frequency);
  lfo.start();
}

function playTone(freq, dur, type='sine', vol=0.15){
  if (!AUDIO.ctx || AUDIO.muted) return;
  const ctx = AUDIO.ctx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type; osc.frequency.value = freq;
  gain.gain.value = vol;
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  osc.connect(gain).connect(AUDIO.master);
  osc.start();
  osc.stop(ctx.currentTime + dur);
}

function playFootstep(){ playTone(70 + Math.random()*20, 0.08, 'triangle', 0.05); }
function playPickup(){ playTone(660, 0.12, 'sine', 0.18); setTimeout(()=>playTone(880,0.15,'sine',0.15), 90); }
function playDenied(){ playTone(140, 0.25, 'sawtooth', 0.12); }
function playCaught(){ playTone(90, 0.9, 'sawtooth', 0.3); }
function playLaunch(){ playTone(50, 3.5, 'sawtooth', 0.25); }
function playShotgun(){ playTone(60, 0.5, 'sawtooth', 0.4); setTimeout(()=>playTone(45,0.6,'square',0.3),40); }
function playDoorCreak(){ playTone(180, 0.6, 'sawtooth', 0.08); setTimeout(()=>playTone(140,0.5,'sawtooth',0.06),200); }

// Dissonant jump-scare musical sting for Lady's 1-minute visits.
function playJumpscareSting(){
  if (!AUDIO.ctx || AUDIO.muted) return;
  const chord = [220, 233.08, 349.23, 415.3]; // tense cluster
  chord.forEach((f,i)=>{
    setTimeout(()=>playTone(f, 1.1, 'sawtooth', 0.22 - i*0.02), i*15);
  });
  playTone(50, 1.4, 'square', 0.3);
}

let heartbeatInterval = null;
function setHeartbeat(active){
  if (active === AUDIO.heartbeatOn) return;
  AUDIO.heartbeatOn = active;
  if (active){
    heartbeatInterval = setInterval(()=>{
      playTone(55, 0.12, 'sine', 0.22);
      setTimeout(()=>playTone(50,0.12,'sine',0.16), 180);
    }, 700);
  } else {
    clearInterval(heartbeatInterval);
  }
}

document.getElementById('muteBtn').addEventListener('click', ()=>{
  AUDIO.muted = !AUDIO.muted;
  document.getElementById('muteBtn').textContent = AUDIO.muted ? '🔇' : '🔊';
  if (AUDIO.master) AUDIO.master.gain.value = AUDIO.muted ? 0 : 0.5;
});

/* =========================================================
   THREE.JS SETUP
========================================================= */
let scene, camera, renderer, controls, clock;
let colliders = []; // each: { box: THREE.Box3, floor: 0|1|-1 }  (-1 = stairwell, always passable)
let interactables = [];
let grandma, grandman, lady;
let velocity = new THREE.Vector3();
let move = { f:false, b:false, l:false, r:false, sprint:false, crouch:false };
let stamina = 100;
let playerHeightStand = 1.7, playerHeightCrouch = 1.0;
let playerHeight = playerHeightStand;
let noiseLevel = 0; // how loud player currently is
let rocketSeated = false;
let floorBaseY = 0; // vertical offset added on top of playerHeight for the current floor/stair progress

export function startGame(config){
  GAME.mode = config.mode;
  GAME.platform = config.platform || 'pc';
  GAME.grandmanEnabled = config.grandmanEnabled;
  GAME.ladyEnabled = config.ladyEnabled;
  GAME.sensitivity = config.sensitivity;
  GAME.running = true;
  initAudio();
  initScene();
  buildHouse();
  buildStairs();
  buildUpperFloor();
  buildRocket();
  spawnItems();
  spawnGrandma();
  if (GAME.grandmanEnabled) spawnGrandman();
  if (GAME.ladyEnabled) spawnLady();
  clock = new THREE.Clock();
  animate();

  if (GAME.platform === 'android'){
    setupMobileControls();
    // No pointer lock on touch devices — the game is considered "active" right away.
    document.body.addEventListener('touchstart', ()=>{
      if (AUDIO.ctx && AUDIO.ctx.state === 'suspended') AUDIO.ctx.resume();
    }, {once:true});
    GAME.mobileActive = true;
  } else {
    document.body.addEventListener('click', ()=>{
      if (AUDIO.ctx && AUDIO.ctx.state === 'suspended') AUDIO.ctx.resume();
      if(!rocketSeated) controls.lock();
    });
  }
}

function initScene(){
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x000000, 0.038);

  camera = new THREE.PerspectiveCamera(72, window.innerWidth/window.innerHeight, 0.05, 500);
  camera.position.set(0, playerHeight, 0);

  renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,1.5));
  renderer.shadowMap.enabled = false; // shadows disabled — 8 shadow-casting lights was crashing weaker GPUs
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  controls = new PointerLockControls(camera, renderer.domElement);
  scene.add(controls.getObject());
  if (GAME.platform === 'pc') applySensitivityPatch();
  else setupMobileLook();

  // lighting: bright, fully-visible house — realistic warm interior, no dark corners
  const ambient = new THREE.AmbientLight(0xffffff, 1.1);
  scene.add(ambient);
  const moonLight = new THREE.DirectionalLight(0xdfe8ff, 0.5);
  moonLight.position.set(-20, 30, -10);
  scene.add(moonLight);
  const fillLight = new THREE.HemisphereLight(0xffffff, 0x555566, 0.6);
  scene.add(fillLight);

  // ceiling lamps spread through every room (ground + upper floor) so nothing is left dark
  const lampSpots = [
    [0, 3.6, 0], [-12.6, 3.6, -11.2], [-12.6, 3.6, 8.4], [2.8, 3.6, -12.6],
    [15.4, 3.6, -4.2], [-2.8, 3.6, 12.6], [8.4, 3.6, -2.8], [0, 3.6, 11.2],
    [0, 7.6, 0], [-12.6, 7.6, -11.2], [8.4, 7.6, -2.8], [15.4, 7.6, -4.2],
  ];
  lampSpots.forEach(([x,y,z])=>{
    const lamp = new THREE.PointLight(0xfff2d9, 1.8, 20, 1.6);
    lamp.position.set(x,y,z);
    lamp.castShadow = false; // shadows off globally — this was the main perf/crash cause
    scene.add(lamp);
    // visible bulb/fixture mesh so the lamp looks like a real light source
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14,12,12), new THREE.MeshStandardMaterial({color:0xfff6dd, emissive:0xffdd99, emissiveIntensity:1.6}));
    bulb.position.set(x,y,z);
    scene.add(bulb);
  });

  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  // Moon surface skybox (simple starfield + earth + distant moon)
  buildSky();
}

function onResize(){
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/* Real mouse-sensitivity control: intercept raw mousemove in the capture phase
   and scale it before PointerLockControls' own listener (added on connect()) sees it. */
function applySensitivityPatch(){
  renderer.domElement.addEventListener('mousemove', (e)=>{
    if (!controls.isLocked) return;
    const scale = GAME.sensitivity - 1;
    if (scale === 0) return;
    const euler = new THREE.Euler(0,0,0,'YXZ');
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= (e.movementX || 0) * 0.0022 * scale;
    euler.x -= (e.movementY || 0) * 0.0022 * scale;
    euler.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, euler.x));
    camera.quaternion.setFromEuler(euler);
  }, true); // capture phase: runs alongside, not instead of, native handling
}

/* =========================================================
   MOBILE (ANDROID) TOUCH CONTROLS
   No mouse/keyboard: dragging on screen looks around, a virtual joystick
   (bottom-left) walks, a round button toggles sit/stand (crouch), and a
   hand button on the right does the "E" interact action.
========================================================= */
let lookTouchId = null;
let lookLast = { x:0, y:0 };
function setupMobileLook(){
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  el.addEventListener('touchstart', (e)=>{
    for (const t of e.changedTouches){
      if (lookTouchId === null){
        lookTouchId = t.identifier;
        lookLast.x = t.clientX; lookLast.y = t.clientY;
      }
    }
  }, {passive:true});
  el.addEventListener('touchmove', (e)=>{
    for (const t of e.changedTouches){
      if (t.identifier === lookTouchId){
        const dx = t.clientX - lookLast.x;
        const dy = t.clientY - lookLast.y;
        lookLast.x = t.clientX; lookLast.y = t.clientY;
        const euler = new THREE.Euler(0,0,0,'YXZ');
        euler.setFromQuaternion(camera.quaternion);
        euler.y -= dx * 0.0032 * GAME.sensitivity;
        euler.x -= dy * 0.0032 * GAME.sensitivity;
        euler.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, euler.x));
        camera.quaternion.setFromEuler(euler);
      }
    }
  }, {passive:true});
  function release(e){
    for (const t of e.changedTouches){
      if (t.identifier === lookTouchId) lookTouchId = null;
    }
  }
  el.addEventListener('touchend', release);
  el.addEventListener('touchcancel', release);
}

const JOY_RADIUS = 55;
let joyTouchId = null;
const joyCenter = { x:0, y:0 };
function setupJoystick(){
  const base = document.getElementById('joyBase');
  const stick = document.getElementById('joyStick');

  function updateStick(cx, cy){
    let dx = cx - joyCenter.x, dy = cy - joyCenter.y;
    const dist = Math.min(JOY_RADIUS, Math.hypot(dx,dy));
    const ang = Math.atan2(dy,dx);
    const sx = Math.cos(ang)*dist, sy = Math.sin(ang)*dist;
    stick.style.transform = `translate(calc(-50% + ${sx}px), calc(-50% + ${sy}px))`;
    joyVec.x = sx / JOY_RADIUS;
    joyVec.y = sy / JOY_RADIUS;
  }
  function start(e){
    const t = e.changedTouches[0];
    joyTouchId = t.identifier;
    const rect = base.getBoundingClientRect();
    joyCenter.x = rect.left + rect.width/2;
    joyCenter.y = rect.top + rect.height/2;
    updateStick(t.clientX, t.clientY);
    e.preventDefault();
  }
  function move(e){
    for (const t of e.changedTouches){
      if (t.identifier === joyTouchId) updateStick(t.clientX, t.clientY);
    }
    e.preventDefault();
  }
  function end(e){
    for (const t of e.changedTouches){
      if (t.identifier === joyTouchId){
        joyTouchId = null;
        joyVec.x = 0; joyVec.y = 0;
        stick.style.transform = 'translate(-50%,-50%)';
      }
    }
  }
  base.addEventListener('touchstart', start, {passive:false});
  base.addEventListener('touchmove', move, {passive:false});
  base.addEventListener('touchend', end);
  base.addEventListener('touchcancel', end);
}

function setupMobileControls(){
  document.getElementById('mobileControls').classList.remove('hidden');
  setupJoystick();

  // Sit/Stand button — left side, toggles crouch just like the C key on PC.
  document.getElementById('crouchBtn').addEventListener('touchstart', (e)=>{
    e.preventDefault();
    move.crouch = !move.crouch;
  }, {passive:false});

  // Hand button — right side. Walking around it's "E" (interact); once seated
  // in the rocket it becomes the ignite button (cockpit slots have their own buttons).
  document.getElementById('handBtn').addEventListener('touchstart', (e)=>{
    e.preventDefault();
    if (rocketSeated){ if (!cockpit.launching) tryIgnite(); }
    else tryInteractNearest();
  }, {passive:false});

  document.getElementById('slotKeyBtn').addEventListener('touchstart', (e)=>{
    e.preventDefault(); placeCockpitItem('key');
  }, {passive:false});
  document.getElementById('slotFuelBtn').addEventListener('touchstart', (e)=>{
    e.preventDefault(); placeCockpitItem('fuel');
  }, {passive:false});
}

/* =========================================================
   SKY / STARFIELD / EARTH / MOON
   Earth sits far off on one side; a grey moon-limb sits on the opposite
   side so the launch sequence reads as "leaving the Moon toward Earth".
========================================================= */
function buildSky(){
  const starGeo = new THREE.BufferGeometry();
  const starCount = 1200;
  const positions = new Float32Array(starCount*3);
  for(let i=0;i<starCount;i++){
    const r = 300;
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos((Math.random()*2)-1);
    positions[i*3] = r*Math.sin(phi)*Math.cos(theta);
    positions[i*3+1] = Math.abs(r*Math.cos(phi));
    positions[i*3+2] = r*Math.sin(phi)*Math.sin(theta);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  const starMat = new THREE.PointsMaterial({ color:0xffffff, size:1.1, sizeAttenuation:false });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  // Earth — glimpsed through the far window, grows large during the flight.
  const earthGeo = new THREE.SphereGeometry(18, 32, 32);
  const earthMat = new THREE.MeshStandardMaterial({ color:0x2255aa, emissive:0x113355, emissiveIntensity:0.4, roughness:0.6 });
  const earth = new THREE.Mesh(earthGeo, earthMat);
  earth.position.set(-160, 70, -240);
  earth.name = 'earth';
  scene.add(earth);
  window.__earth = earth;

  // Moon curvature — the ground we're standing on, visible receding on the opposite side once airborne.
  const moonGeo = new THREE.SphereGeometry(90, 32, 32);
  const moonMat = new THREE.MeshStandardMaterial({ color:0x9a9a92, roughness:0.95, emissive:0x1a1a18, emissiveIntensity:0.25 });
  const moon = new THREE.Mesh(moonGeo, moonMat);
  moon.position.set(140, -60, 210);
  moon.name = 'moon';
  moon.visible = false; // only revealed once we're airborne looking back down
  scene.add(moon);
  window.__moon = moon;
}

/* =========================================================
   HOUSE GEOMETRY (boxy but textured/lit realistically)
   House footprint enlarged to 42 x 34 (was 30 x 24) across two floors.
========================================================= */
/* ---- procedural textures (canvas-based, no external image files needed) ---- */
function makeCanvasTexture(size, drawFn, repeatX=4, repeatY=4){
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  drawFn(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const woodTex = makeCanvasTexture(256, (ctx,s)=>{
  ctx.fillStyle = '#6b4526'; ctx.fillRect(0,0,s,s);
  for(let i=0;i<40;i++){
    ctx.strokeStyle = `rgba(40,20,8,${0.15+Math.random()*0.25})`;
    ctx.lineWidth = 1 + Math.random()*2;
    ctx.beginPath();
    const y = Math.random()*s;
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(s*0.3, y+Math.random()*14-7, s*0.7, y+Math.random()*14-7, s, y);
    ctx.stroke();
  }
}, 2, 2);

const floorTex = makeCanvasTexture(256, (ctx,s)=>{
  ctx.fillStyle = '#22242c'; ctx.fillRect(0,0,s,s);
  const tiles = 4, tSize = s/tiles;
  for(let i=0;i<tiles;i++) for(let j=0;j<tiles;j++){
    ctx.fillStyle = (i+j)%2===0 ? '#262a34' : '#1d1f27';
    ctx.fillRect(i*tSize, j*tSize, tSize, tSize);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 2;
    ctx.strokeRect(i*tSize, j*tSize, tSize, tSize);
  }
}, 8, 7);

const wallTex = makeCanvasTexture(256, (ctx,s)=>{
  ctx.fillStyle = '#3d4152'; ctx.fillRect(0,0,s,s);
  const img = ctx.getImageData(0,0,s,s);
  for(let i=0;i<img.data.length;i+=4){
    const n = (Math.random()-0.5)*18;
    img.data[i]+=n; img.data[i+1]+=n; img.data[i+2]+=n;
  }
  ctx.putImageData(img,0,0);
}, 4, 2);

const grassTex = makeCanvasTexture(256, (ctx,s)=>{
  ctx.fillStyle = '#2e5a2a'; ctx.fillRect(0,0,s,s);
  for(let i=0;i<300;i++){
    ctx.strokeStyle = `rgba(${20+Math.random()*30},${70+Math.random()*50},${20+Math.random()*20},0.5)`;
    ctx.lineWidth = 1;
    const x = Math.random()*s, y = Math.random()*s;
    ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+Math.random()*4-2, y-6-Math.random()*6); ctx.stroke();
  }
}, 10, 10);

const matWall = new THREE.MeshStandardMaterial({ map:wallTex, color:0xffffff, roughness:0.92 });
const matFloor = new THREE.MeshStandardMaterial({ map:floorTex, color:0xffffff, roughness:0.55, metalness:0.05 });
const matWood = new THREE.MeshStandardMaterial({ map:woodTex, color:0xffffff, roughness:0.65 });
const matMetal = new THREE.MeshStandardMaterial({ color:0x9a9ea8, roughness:0.28, metalness:0.85 });
const matGlass = new THREE.MeshPhysicalMaterial({ color:0x9fd0ff, transparent:true, opacity:0.22, roughness:0.04, transmission:0.9 });
const matFabric = new THREE.MeshStandardMaterial({ color:0x6b3f4f, roughness:0.95 });
const matSkin = new THREE.MeshStandardMaterial({ color:0xd9b899, roughness:0.7 });
const matGrass = new THREE.MeshStandardMaterial({ map:grassTex, color:0xffffff, roughness:0.95 });
const matDoor = new THREE.MeshStandardMaterial({ color:0x4a2f1a, roughness:0.6, map:woodTex });

function box(w,h,d, mat, x,y,z, castShadow=true){
  const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
  m.position.set(x,y,z);
  m.castShadow = castShadow; m.receiveShadow = true;
  scene.add(m);
  return m;
}

function wallCollider(mesh, floor=0){
  const box3 = new THREE.Box3().setFromObject(mesh);
  colliders.push({ box: box3, floor });
}

const WALL_H = 4; // per-floor wall height (2 floors => building is 8 tall total)

function buildHouse(){
  // Ground floor slab (house enlarged to 42 x 34, up from 30 x 24)
  const floor = box(42, 0.2, 34, matFloor, 0, -0.1, 0, false);
  floor.receiveShadow = true;

  const wallT = 0.3;
  // Outer walls, ground floor
  const walls = [
    box(42, WALL_H, wallT, matWall, 0, WALL_H/2, -17), // back
    box(wallT, WALL_H, 34, matWall, -21, WALL_H/2, 0), // left
    box(wallT, WALL_H, 34, matWall, 21, WALL_H/2, 0),  // right
  ];
  walls.forEach(w=>wallCollider(w,0));

  // Front wall has a real DOORWAY cut into it (centered at x=0), now sealed by
  // an actual MAIN DOOR that only opens once the player holds the Main Door Key.
  const doorWidth = 3.5;
  const frontLeft  = box((42-doorWidth)/2, WALL_H, wallT, matWall, -(doorWidth/2 + (42-doorWidth)/4), WALL_H/2, 17);
  const frontRight = box((42-doorWidth)/2, WALL_H, wallT, matWall,  (doorWidth/2 + (42-doorWidth)/4), WALL_H/2, 17);
  wallCollider(frontLeft,0); wallCollider(frontRight,0);
  box(doorWidth, WALL_H-2.6, wallT, matWall, 0, WALL_H-1.3, 17, false); // lintel

  buildMainDoor(doorWidth, 17);

  // outdoor ground extending from the main door out to the launch pad
  box(doorWidth+6, 0.2, 20, matGrass, 0, -0.1, 27, false);
  const padLight = new THREE.PointLight(0xfff2d9, 1.6, 24, 1.6);
  padLight.position.set(0, 4, 29);
  scene.add(padLight);

  // Windows showing the moon/earth view
  box(4, 2, 0.05, matGlass, -8.4, 2.2, -17.1, false);
  box(4, 2, 0.05, matGlass, 8.4, 2.2, 16.9, false);

  // Interior dividing walls creating rooms: living room, hallway, bedroom, study(safe room), garage(rocket bay)
  const div1 = box(0.3, WALL_H, 19.6, matWall, -4.2, WALL_H/2, -5.6); wallCollider(div1,0);
  const div2 = box(14, WALL_H, 0.3, matWall, 7, WALL_H/2, 2.8); wallCollider(div2,0);
  const div3 = box(0.3, WALL_H, 14, matWall, 12.6, WALL_H/2, -8.4); wallCollider(div3,0);

  // furniture -- beds, tables, shelves (also colliders + hiding spots)
  addFurniture(-12.6, -11.2, 'bed');
  addFurniture(-12.6, 8.4, 'table');
  addFurniture(2.8, -12.6, 'shelf');
  addFurniture(15.4, -4.2, 'safeStand');
  addFurniture(-2.8, 12.6, 'crate');
  addFurniture(8.4, -2.8, 'sofa');

  scene.userData.rooms = true;
}

/* Main door: a real door mesh blocking the doorway until the player has the
   Main Door Key. Swings open on a hinge once unlocked. */
let mainDoorPivot, mainDoorCollider;
function buildMainDoor(width, z){
  mainDoorPivot = new THREE.Group();
  mainDoorPivot.position.set(-width/2, 0, z); // hinge on the left edge
  const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(width, WALL_H-1.3, 0.15), matDoor);
  doorMesh.position.set(width/2, (WALL_H-1.3)/2, 0);
  doorMesh.castShadow = true; doorMesh.receiveShadow = true;
  mainDoorPivot.add(doorMesh);
  const handle = new THREE.Mesh(new THREE.SphereGeometry(0.08,10,10), new THREE.MeshStandardMaterial({color:0xffcf6b, emissive:0xffaa33, emissiveIntensity:0.6}));
  handle.position.set(width-0.3, (WALL_H-1.3)/2, 0.12);
  mainDoorPivot.add(handle);
  scene.add(mainDoorPivot);

  const doorBox3 = new THREE.Box3().setFromObject(mainDoorPivot);
  mainDoorCollider = { box: doorBox3, floor: 0 };
  colliders.push(mainDoorCollider);

  const marker = new THREE.Object3D();
  marker.position.set(0, 1.2, z);
  scene.add(marker);
  interactables.push({
    obj: marker, type:'mainDoor', range:2.2,
    prompt: GAME.mainDoorOpen ? '' : 'Press E to open Main Door (needs Main Door Key)',
    onInteract: tryOpenMainDoor,
  });
}

function tryOpenMainDoor(){
  if (GAME.mainDoorOpen) return;
  if (!GAME.inventory.includes('Main Door Key')){
    showPrompt('The main door is locked. Find the Main Door Key.', 1800);
    playDenied();
    return;
  }
  GAME.mainDoorOpen = true;
  removeFromInventory('Main Door Key');
  // remove its collider so the player can walk through
  const idx = colliders.indexOf(mainDoorCollider);
  if (idx > -1) colliders.splice(idx,1);
  playDoorCreak();
  showPrompt('The main door creaks open.', 1800);
  // swing animation
  let t = 0;
  function swing(){
    t += 0.016;
    const p = Math.min(1, t/1.0);
    mainDoorPivot.rotation.y = -p * (Math.PI*0.8);
    if (p < 1) requestAnimationFrame(swing);
  }
  swing();
}

function addFurniture(x,z,type){
  let colliderMesh; // primary mesh used for collision bounds
  const g = new THREE.Group();
  g.position.set(x,0,z);

  switch(type){
    case 'bed': {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(2.2,0.35,3.4), matWood);
      frame.position.y = 0.2; g.add(frame);
      const mattress = new THREE.Mesh(new THREE.BoxGeometry(2.0,0.3,3.2), new THREE.MeshStandardMaterial({color:0xe8e4d8, roughness:0.9}));
      mattress.position.y = 0.5; g.add(mattress);
      const pillow = new THREE.Mesh(new THREE.BoxGeometry(1.6,0.18,0.6), new THREE.MeshStandardMaterial({color:0xffffff, roughness:0.95}));
      pillow.position.set(0, 0.68, -1.3); g.add(pillow);
      const blanket = new THREE.Mesh(new THREE.BoxGeometry(2.0,0.12,2.0), matFabric);
      blanket.position.set(0, 0.66, 0.5); g.add(blanket);
      colliderMesh = frame;
      break;
    }
    case 'table': {
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.8,0.1,1.8), matWood);
      top.position.y = 0.75; g.add(top);
      const legGeo = new THREE.BoxGeometry(0.12,0.75,0.12);
      [[-0.8,-0.8],[0.8,-0.8],[-0.8,0.8],[0.8,0.8]].forEach(([lx,lz])=>{
        const leg = new THREE.Mesh(legGeo, matWood);
        leg.position.set(lx, 0.375, lz); g.add(leg);
      });
      colliderMesh = top;
      break;
    }
    case 'shelf': {
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.4,2.2,0.1), matWood);
      back.position.set(0,1.1,-0.2); g.add(back);
      for(let i=0;i<4;i++){
        const shelfBoard = new THREE.Mesh(new THREE.BoxGeometry(2.3,0.06,0.5), matWood);
        shelfBoard.position.set(0, 0.3+i*0.6, 0); g.add(shelfBoard);
      }
      colliderMesh = back;
      break;
    }
    case 'safeStand': {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(1.2,1.0,1.0), matMetal);
      stand.position.y = 0.5; g.add(stand);
      const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,0.05,16), new THREE.MeshStandardMaterial({color:0x222222, metalness:0.6, roughness:0.3}));
      dial.rotation.x = Math.PI/2; dial.position.set(0, 0.5, 0.53); g.add(dial);
      colliderMesh = stand;
      break;
    }
    case 'crate': {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.0,1.0,1.0), matWood);
      crate.position.y = 0.5; g.add(crate);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(crate.geometry), new THREE.LineBasicMaterial({color:0x2a1a0e}));
      edges.position.copy(crate.position); g.add(edges);
      colliderMesh = crate;
      break;
    }
    case 'sofa': {
      const base = new THREE.Mesh(new THREE.BoxGeometry(2.6,0.5,1.2), matFabric);
      base.position.y = 0.3; g.add(base);
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.6,0.6,0.25), matFabric);
      back.position.set(0,0.65,-0.48); g.add(back);
      [-0.85, 0, 0.85].forEach(cx=>{
        const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.75,0.25,1.05), new THREE.MeshStandardMaterial({color:0x7a4a5c, roughness:0.9}));
        cushion.position.set(cx, 0.62, 0.03); g.add(cushion);
      });
      colliderMesh = base;
      break;
    }
    case 'armchair': {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(1.1,0.5,1.1), matFabric);
      seat.position.y = 0.3; g.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(1.1,0.9,0.25), matFabric);
      back.position.set(0,0.75,-0.45); g.add(back);
      colliderMesh = seat;
      break;
    }
  }

  g.traverse(o=>{ if(o.isMesh){ o.castShadow = true; o.receiveShadow = true; } });
  scene.add(g);
  if (colliderMesh){
    const box3 = new THREE.Box3().setFromObject(g);
    colliders.push({ box: box3, floor: 0 });
  }
}

/* =========================================================
   STAIRS — a walkable ramp connecting ground floor to the upper floor.
   Vertical movement is simulated (no full 3D physics): while the player's
   x/z sits inside the ramp footprint, height is interpolated smoothly.
========================================================= */
const STAIRS = { x0:14.6, x1:19.6, z0:-15.6, z1:-9.6, }; // footprint in world space (near the safe room, right side)
function buildStairs(){
  const steps = 10;
  const stepLen = (STAIRS.z1 - STAIRS.z0)/steps;
  for(let i=0;i<steps;i++){
    const y = (i/steps)*WALL_H;
    const stepMesh = new THREE.Mesh(new THREE.BoxGeometry(STAIRS.x1-STAIRS.x0, 0.25, stepLen+0.05),
      new THREE.MeshStandardMaterial({ map:woodTex, color:0xffffff, roughness:0.7 }));
    stepMesh.position.set((STAIRS.x0+STAIRS.x1)/2, y, STAIRS.z0 + stepLen*(i+0.5));
    stepMesh.castShadow = true; stepMesh.receiveShadow = true;
    scene.add(stepMesh);
  }
  // side rails
  const railMat = new THREE.MeshStandardMaterial({color:0x2a2a30, metalness:0.5, roughness:0.4});
  [STAIRS.x0, STAIRS.x1].forEach(x=>{
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, STAIRS.z1-STAIRS.z0), railMat);
    rail.position.set(x, WALL_H/2, (STAIRS.z0+STAIRS.z1)/2);
    scene.add(rail);
  });
}

// Returns stair progress 0..1 if (x,z) is within the stair footprint, else null.
function stairProgress(x,z){
  if (x < STAIRS.x0-0.2 || x > STAIRS.x1+0.2) return null;
  if (z < STAIRS.z0-0.2 || z > STAIRS.z1+0.2) return null;
  return Math.max(0, Math.min(1, (z - STAIRS.z0)/(STAIRS.z1 - STAIRS.z0)));
}

/* =========================================================
   UPPER FLOOR — second story with its own walls, a grandman's sleeping nook,
   and the main door key hidden inside.
========================================================= */
function buildUpperFloor(){
  // Upper floor slab (visual only — vertical travel is handled by the stairs, not real collision)
  box(42, 0.2, 34, matFloor, 0, WALL_H, 0, false);

  const wallT = 0.3, y2 = WALL_H + WALL_H/2;
  const upperWalls = [
    box(42, WALL_H, wallT, matWall, 0, y2, -17), // back
    box(wallT, WALL_H, 34, matWall, -21, y2, 0), // left
    box(wallT, WALL_H, 34, matWall, 21, y2, 0),  // right
    box(42, WALL_H, wallT, matWall, 0, y2, 17),  // front (solid up here — no doorway needed)
  ];
  upperWalls.forEach(w=>wallCollider(w,1));

  // roof
  box(42, 0.3, 34, matWall, 0, WALL_H*2+0.2, 0, false);

  // window looking out at the moon/stars
  box(4, 2, 0.05, matGlass, 0, WALL_H+2.2, -17.1, false);

  // A simple partition making a small "grandman's room" in the corner where the stairs arrive
  const upperDiv = box(0.3, WALL_H, 12, matWall, 10, y2, -11.6); wallCollider(upperDiv,1);

  // Grandman's armchair — this is where he sleeps until the player gets close
  addFurniture(16, -13, 'armchair');
  addFurniture(-10, -10, 'bed');
  addFurniture(-4, 10, 'shelf');

  // Main Door Key — tucked on the upper shelf, encouraging exploration upstairs
  const key = makeItemMesh(0xb87333, 0.28);
  key.position.set(-4, WALL_H+1.3, 10.3);
  scene.add(key);
  interactables.push({ obj:key, type:'pickup', range:1.6, prompt:'Press E to pick up Main Door Key',
    onInteract: ()=>{ GAME.hasMainDoorKey = true; pickup('Main Door Key','🔑'); scene.remove(key); playPickup(); }});
}

/* =========================================================
   ROCKET (outside, past the main door)
========================================================= */
let rocket, rocketBodyGroup;
function buildRocket(){
  rocketBodyGroup = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.3,1.3,7,24), new THREE.MeshStandardMaterial({color:0xdedede, metalness:0.6, roughness:0.3}));
  body.position.y = 3.5;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.3,2.2,24), new THREE.MeshStandardMaterial({color:0xff5533, metalness:0.4, roughness:0.4}));
  nose.position.y = 8.1;
  const finGeo = new THREE.BoxGeometry(0.15,1.4,1.2);
  const finMat = new THREE.MeshStandardMaterial({color:0x8b1a1a});
  for(let i=0;i<4;i++){
    const fin = new THREE.Mesh(finGeo, finMat);
    const a = (i/4)*Math.PI*2;
    fin.position.set(Math.cos(a)*1.3, 0.7, Math.sin(a)*1.3);
    fin.rotation.y = a;
    rocketBodyGroup.add(fin);
  }
  rocketBodyGroup.add(body, nose);
  rocketBodyGroup.position.set(0, 0, 30.8); // outside past the main door
  rocketBodyGroup.castShadow = true;
  scene.add(rocketBodyGroup);

  // launch pad
  box(6,0.3,6, matMetal, 0, -0.05, 30.8, false);

  // seat interactable trigger (near base of rocket)
  const seatMarker = new THREE.Object3D();
  seatMarker.position.set(0, 1, 28.7);
  scene.add(seatMarker);
  interactables.push({
    obj: seatMarker, type:'rocketSeat', range:2.2,
    prompt: 'Press E to board the rocket',
    onInteract: tryBoardRocket
  });

  buildRocketInterior();
}

/* ---- Cockpit interior: seat, console with item slots, glass canopy window ---- */
let rocketInterior = null;
function buildRocketInterior(){
  const interior = new THREE.Group();
  interior.position.set(0, 6.4, 0);

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.6,0.15,0.6), matMetal);
  seat.position.set(0,-0.35,0.15); interior.add(seat);
  const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.6,0.5,0.1), matMetal);
  seatBack.position.set(0,-0.05,0.42); interior.add(seatBack);

  const consolePanel = new THREE.Mesh(new THREE.BoxGeometry(0.7,0.35,0.3), new THREE.MeshStandardMaterial({color:0x1c1e26, roughness:0.5, metalness:0.4}));
  consolePanel.position.set(0,-0.25,-0.55); interior.add(consolePanel);

  const keySlot = new THREE.Mesh(new THREE.BoxGeometry(0.14,0.06,0.1), new THREE.MeshStandardMaterial({color:0xffcf6b, emissive:0xffaa33, emissiveIntensity:0.5}));
  keySlot.position.set(-0.16,-0.06,-0.55); interior.add(keySlot);
  const fuelSlot = new THREE.Mesh(new THREE.BoxGeometry(0.14,0.06,0.1), new THREE.MeshStandardMaterial({color:0x33ff88, emissive:0x22aa55, emissiveIntensity:0.5}));
  fuelSlot.position.set(0.16,-0.06,-0.55); interior.add(fuelSlot);

  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.1, 20, 14, 0, Math.PI*2, 0, Math.PI*0.6), matGlass);
  dome.position.set(0,0.1,0); interior.add(dome);

  for(let i=0;i<6;i++){
    const a = (i/6)*Math.PI*2;
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.04,1.0,0.04), matMetal);
    rib.position.set(Math.cos(a)*1.05, 0.4, Math.sin(a)*1.05);
    rib.rotation.z = Math.PI/2 - a;
    interior.add(rib);
  }

  rocketBodyGroup.add(interior);
  rocketInterior = { keySlot, fuelSlot };
}

function tryBoardRocket(){
  if (!GAME.hasLaunchKey){
    showPrompt('You need the LAUNCH KEY from the safe first.', 1800);
    playDenied();
    return;
  }
  if (!GAME.inventory.includes('Fuel Cell')){
    showPrompt('You need the FUEL CELL before boarding.', 1800);
    playDenied();
    return;
  }
  beginLaunchSequence();
}

/* =========================================================
   COCKPIT: place items before ignition
========================================================= */
const cockpit = { keyPlaced:false, fuelPlaced:false, launching:false };

function showCockpitPanel(){
  cockpit.keyPlaced = false; cockpit.fuelPlaced = false; cockpit.launching = false;
  document.getElementById('cockpitPanel').classList.remove('hidden');
  if (GAME.platform === 'android') document.getElementById('mobileCockpitBtns').classList.remove('hidden');
  updateCockpitPanel();
}
function hideCockpitPanel(){
  document.getElementById('cockpitPanel').classList.add('hidden');
  document.getElementById('mobileCockpitBtns').classList.add('hidden');
}

function removeFromInventory(name){
  const i = GAME.inventory.indexOf(name);
  if (i > -1) GAME.inventory.splice(i,1);
  renderInventory();
}

function placeCockpitItem(kind){
  if (kind === 'key'){
    if (cockpit.keyPlaced || !GAME.inventory.includes('Launch Key')) return;
    cockpit.keyPlaced = true;
    removeFromInventory('Launch Key');
    if (rocketInterior) rocketInterior.keySlot.material.emissiveIntensity = 1.6;
  } else if (kind === 'fuel'){
    if (cockpit.fuelPlaced || !GAME.inventory.includes('Fuel Cell')) return;
    cockpit.fuelPlaced = true;
    removeFromInventory('Fuel Cell');
    if (rocketInterior) rocketInterior.fuelSlot.material.emissiveIntensity = 1.6;
  }
  playPickup();
  updateCockpitPanel();
}

function updateCockpitPanel(){
  document.getElementById('slotKey').classList.toggle('placed', cockpit.keyPlaced);
  document.getElementById('slotFuel').classList.toggle('placed', cockpit.fuelPlaced);
  document.getElementById('igniteHint').classList.toggle('show', cockpit.keyPlaced && cockpit.fuelPlaced);
}

function tryIgnite(){
  if (cockpit.keyPlaced && cockpit.fuelPlaced){
    cockpit.launching = true;
    hideCockpitPanel();
    launchCountdown();
  } else {
    showPrompt('Place both items first (press 1 and 2).', 1400);
    playDenied();
  }
}

/* =========================================================
   HOLD / DROP SYSTEM (tools are carried visibly, can be dropped)
========================================================= */
const HELD = { itemName:null, mesh:null };

function equipHeldItem(name, color){
  if (HELD.mesh) camera.remove(HELD.mesh);
  HELD.itemName = name;
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.18,0.18,0.5), new THREE.MeshStandardMaterial({color}));
  m.position.set(0.28, -0.22, -0.55);
  m.rotation.set(0.1, 0.4, 0);
  camera.add(m);
  HELD.mesh = m;
}

function makeItemMesh(color, size=0.3){
  const m = new THREE.Mesh(new THREE.BoxGeometry(size,size,size), new THREE.MeshStandardMaterial({color, emissive:color, emissiveIntensity:0.15}));
  m.castShadow = true;
  return m;
}

function spawnItems(){
  // Crowbar - pries open a locked box
  const crowbar = makeItemMesh(0xd4a017, 0.5);
  crowbar.position.set(-13.16, 0.75, 7.84);
  scene.add(crowbar);
  interactables.push({ obj:crowbar, type:'pickup', range:1.6, prompt:'Press E to pick up Crowbar',
    onInteract: ()=>{ pickup('Crowbar','🔧'); scene.remove(crowbar); equipHeldItem('Crowbar',0xd4a017); playPickup(); }});

  // Locked box (needs crowbar) containing safe code note
  const lbox = box(0.8,0.6,0.8, matWood, -2.8, 1.0, 12.6);
  interactables.push({ obj:lbox, type:'lockedBox', range:1.8, prompt:'Press E to pry open box (needs Crowbar)',
    onInteract: ()=>{
      if (!GAME.inventory.includes('Crowbar')){ showPrompt('Locked. You need a Crowbar.', 1600); playDenied(); return; }
      if (GAME.boxOpened) return;
      GAME.boxOpened = true;
      showPrompt('You found a note: Safe code is 7-3-1', 2600);
      pickup('Safe Code Note','📝');
      playPickup();
    }});

  // Safe requiring code, near safeStand furniture
  const safe = box(1.0,0.9,0.9, matMetal, 15.4, 0.85, -4.2);
  interactables.push({ obj:safe, type:'safe', range:1.8, prompt:'Press E to open safe (needs code)',
    onInteract: ()=>{
      if (!GAME.inventory.includes('Safe Code Note')){ showPrompt('It\'s locked. Find the code first.', 1600); playDenied(); return; }
      if (GAME.safeUnlocked) return;
      GAME.safeUnlocked = true;
      showPrompt('Safe opened! You found the ROCKET LAUNCH KEY.', 2400);
      pickup('Launch Key','🗝️');
      GAME.hasLaunchKey = true;
      playPickup();
    }});

  // Fuel cell (flavor pickup, needed narratively before boarding)
  const fuel = makeItemMesh(0x33ff88, 0.4);
  fuel.position.set(2.8, 1.3, -13.02);
  scene.add(fuel);
  interactables.push({ obj:fuel, type:'pickup', range:1.6, prompt:'Press E to pick up Fuel Cell',
    onInteract: ()=>{ pickup('Fuel Cell','🔋'); scene.remove(fuel); playPickup(); }});

  // Main Door Key is spawned upstairs in buildUpperFloor()
}

function pickup(name, icon){
  if (GAME.inventory.includes(name)) return;
  GAME.inventory.push(name);
  renderInventory();
  showItemPopup(name, icon);
  // Grandma always clocks your position the moment you pick something up —
  // she immediately starts hunting toward wherever you currently are.
  if (grandma && grandma.active){
    grandma.state = 'chase';
    grandma.alertTimer = 0;
  }
}

// 1-second popup announcing what was just picked up.
let itemPopupTimer = null;
function showItemPopup(name, icon){
  const el = document.getElementById('itemPopup');
  if (!el) return;
  el.textContent = (icon ? icon + ' ' : '') + 'Picked up: ' + name;
  el.classList.add('show');
  clearTimeout(itemPopupTimer);
  itemPopupTimer = setTimeout(()=>el.classList.remove('show'), 1000);
}

function renderInventory(){
  const bar = document.getElementById('inventoryBar');
  bar.innerHTML = '';
  GAME.inventory.forEach(it=>{
    const slot = document.createElement('div');
    slot.className = 'invSlot';
    slot.title = it;
    slot.textContent = ({'Crowbar':'🔧','Safe Code Note':'📝','Launch Key':'🗝️','Fuel Cell':'🔋','Main Door Key':'🔑'})[it] || '❔';
    bar.appendChild(slot);
  });
}

/* =========================================================
   ANTAGONIST MODEL — a proportioned humanoid (not a cartoon capsule)
========================================================= */
function buildHumanoid({skin=0xcfa980, outfit=0x33313c, hair=0xd8d3c8, hasWeapon=false, weaponColor=0x1c1c1c, transparent=false, opacity=1}={}){
  const g = new THREE.Group();
  const skinMat   = new THREE.MeshStandardMaterial({color:skin, roughness:0.75, transparent, opacity});
  const outfitMat = new THREE.MeshStandardMaterial({color:outfit, roughness:0.88, transparent, opacity});
  const hairMat   = new THREE.MeshStandardMaterial({color:hair, roughness:0.9, transparent, opacity});

  // legs
  const legGeo = new THREE.CylinderGeometry(0.1,0.13,0.85,10);
  const legL = new THREE.Mesh(legGeo, outfitMat); legL.position.set(-0.13,0.43,0); g.add(legL);
  const legR = new THREE.Mesh(legGeo, outfitMat); legR.position.set(0.13,0.43,0); g.add(legR);

  // hips + tapered torso for a realistic silhouette instead of a straight capsule
  const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.19,0.25,12), outfitMat);
  hips.position.y = 0.95; g.add(hips);
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.19,0.24,0.75,12), outfitMat);
  torso.position.y = 1.42; g.add(torso);

  // arms
  const armGeo = new THREE.CylinderGeometry(0.075,0.09,0.72,10);
  const armL = new THREE.Mesh(armGeo, outfitMat); armL.position.set(-0.37,1.38,0); armL.rotation.z = 0.16; g.add(armL);
  const armR = new THREE.Mesh(armGeo, outfitMat); armR.position.set(0.37,1.38,0); armR.rotation.z = -0.16; g.add(armR);
  const handGeo = new THREE.SphereGeometry(0.065,10,10);
  const handL = new THREE.Mesh(handGeo, skinMat); handL.position.set(-0.44,1.06,0); g.add(handL);
  const handR = new THREE.Mesh(handGeo, skinMat); handR.position.set(0.44,1.06,0); g.add(handR);

  // neck + head + hair
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.09,0.12,10), skinMat);
  neck.position.y = 1.84; g.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.185,18,16), skinMat);
  head.position.y = 2.03; g.add(head);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.195,18,12,0,Math.PI*2,0,Math.PI*0.62), hairMat);
  hairCap.position.y = 2.07; g.add(hairCap);

  if (hasWeapon){
    // shotgun — a bit chunkier than a generic gun so it reads clearly
    const gunGroup = new THREE.Group();
    const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.75,0.1,0.1), new THREE.MeshStandardMaterial({color:weaponColor, metalness:0.6, roughness:0.35}));
    gunGroup.add(gunBody);
    const gunStock = new THREE.Mesh(new THREE.BoxGeometry(0.22,0.14,0.08), new THREE.MeshStandardMaterial({color:0x3a2418, roughness:0.7}));
    gunStock.position.x = -0.42; gunGroup.add(gunStock);
    gunGroup.position.set(0.58,1.15,0.14); gunGroup.rotation.y = 0.3;
    gunGroup.name = 'shotgun';
    g.add(gunGroup);
  }

  g.traverse(o=>{ if(o.isMesh){ o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/* =========================================================
   GRANDMA — the core threat. Always active (per difficulty, except Practice).
   She hunts by sight/hearing, and instantly knows your position the moment
   you pick anything up. Any touch is instant game over.
========================================================= */
function spawnGrandma(){
  const g = buildHumanoid({ skin:0xc9a488, outfit:0x5a2233, hair:0xe6e2d8, hasWeapon:false });
  g.position.set(12.6, 0, -12.6);
  g.castShadow = true;
  scene.add(g);

  const diff = DIFFICULTY[GAME.mode];
  grandma = {
    mesh:g, state:'patrol', speed: diff.speed, vision: diff.vision, hearing: diff.hearing,
    waypoints: [ new THREE.Vector3(12.6,0,-12.6), new THREE.Vector3(-12.6,0,-11.2), new THREE.Vector3(-12.6,0,8.4), new THREE.Vector3(8.4,0,-2.8)],
    wpIndex:0, alertTimer:0, active: diff.active,
  };
}

function updateGrandma(dt, playerPos){
  if (!grandma || !grandma.active) return;
  const gp = grandma.mesh.position;
  const distToPlayer = gp.distanceTo(playerPos);

  const canHear = distToPlayer < grandma.hearing * (noiseLevel);
  const canSee = distToPlayer < grandma.vision * 0.6;

  if (grandma.state !== 'chase' && (canHear || canSee)){
    grandma.state = 'chase';
  }

  if (grandma.state === 'chase'){
    const dir = new THREE.Vector3().subVectors(playerPos, gp).setY(0).normalize();
    gp.addScaledVector(dir, grandma.speed*dt);
    grandma.mesh.lookAt(playerPos.x, gp.y, playerPos.z);
    if (distToPlayer > grandma.vision*1.4 && noiseLevel < 0.15){
      grandma.alertTimer += dt;
      if (grandma.alertTimer > 4){ grandma.state='patrol'; grandma.alertTimer=0; }
    } else grandma.alertTimer = 0;

    if (distToPlayer < 1.1){
      catchPlayer();
    }
  } else {
    const target = grandma.waypoints[grandma.wpIndex];
    const dir = new THREE.Vector3().subVectors(target, gp).setY(0);
    if (dir.length() < 0.5){
      grandma.wpIndex = (grandma.wpIndex+1) % grandma.waypoints.length;
    } else {
      dir.normalize();
      gp.addScaledVector(dir, grandma.speed*0.5*dt);
      grandma.mesh.lookAt(target.x, gp.y, target.z);
    }
  }

  const vign = document.getElementById('dangerVignette');
  if (grandma.state === 'chase'){ vign.classList.add('danger'); setHeartbeat(true); }
  else { vign.classList.remove('danger'); setHeartbeat(false); }
}

/* =========================================================
   GRANDMAN — optional extra threat. Sleeps in his armchair upstairs and only
   wakes when the player gets close. Once awake he hunts you down and kills
   with a single shotgun blast if he gets a clear shot in range.
========================================================= */
function spawnGrandman(){
  const g = buildHumanoid({ skin:0xcfa980, outfit:0x34323d, hair:0xdbd6cc, hasWeapon:true });
  g.position.set(16, 0.9+4, -13); // seated in his armchair, upper floor
  g.rotation.x = -0.15; // slumped, asleep
  g.castShadow = true;
  scene.add(g);

  const diff = DIFFICULTY[GAME.mode];
  grandman = {
    mesh:g, asleep:true, speed: diff.speed*1.05, wakeRadius: diff.wake, reactTime: diff.react,
    homePos: new THREE.Vector3(16,4,-13), aimTimer:0, aiming:false, active: diff.active,
  };
}

function updateGrandman(dt, playerPos){
  if (!grandman || !grandman.active) return;
  const pos = grandman.mesh.position;
  const dist = pos.distanceTo(playerPos);

  if (grandman.asleep){
    if (dist < grandman.wakeRadius){
      grandman.asleep = false;
      grandman.mesh.rotation.x = 0; // sits up
      playTone(90,0.4,'sawtooth',0.2); // grumble/wake sound
      showPrompt("Grandman's shotgun creaks awake somewhere nearby...", 2200);
    }
    return;
  }

  // Awake: hunt the player.
  const dir = new THREE.Vector3().subVectors(playerPos, pos).setY(0);
  const distXZ = dir.length();
  if (distXZ > 0.01) dir.normalize();
  grandman.mesh.lookAt(playerPos.x, pos.y, playerPos.z);

  const SHOTGUN_RANGE = 7.5;
  if (distXZ < SHOTGUN_RANGE){
    // In range: stop and aim, then fire after the difficulty-scaled reaction time.
    grandman.aiming = true;
    grandman.aimTimer += dt;
    if (grandman.aimTimer >= grandman.reactTime){
      playShotgun();
      catchPlayer(false, true); // killed by grandman's shotgun
    }
  } else {
    grandman.aiming = false;
    grandman.aimTimer = 0;
    pos.addScaledVector(dir, grandman.speed*dt);
  }

  // melee fallback if he closes all the way in
  if (distXZ < 1.1){
    catchPlayer(false, true);
  }
}

/* =========================================================
   LADY — a jump-scare stalker who visits every 60 seconds.
   On each visit she appears right in front of the player wearing a
   horror face, the screen vibrates left/right, and a dissonant sting
   plays. Getting touched during a visit is instant game over.
========================================================= */
function spawnLady(){
  const g = buildHumanoid({ skin:0x1c1c26, outfit:0x140018, hair:0x000000, hasWeapon:false, transparent:true, opacity:0.9 });
  g.scale.set(1, 1.12, 1);
  g.position.set(-15.4, 0, 12.6);
  g.visible = false; // hidden between visits
  scene.add(g);
  lady = { mesh:g, timer:0, scareActive:false, scareTimer:0, interval:60 };
}

function updateLady(dt, playerPos){
  if (!lady || GAME.mode === 'practice') return;
  lady.timer += dt;

  if (!lady.scareActive){
    if (lady.timer >= lady.interval){
      lady.timer = 0;
      triggerLadyScare(playerPos);
    }
    return;
  }

  // during a scare, she stands close in front of the player
  lady.scareTimer += dt;
  const sp = lady.mesh.position;
  if (sp.distanceTo(playerPos) < 0.9){
    catchPlayer(true);
  }
  if (lady.scareTimer > 1.6){
    endLadyScare();
  }
}

function triggerLadyScare(playerPos){
  lady.scareActive = true;
  lady.scareTimer = 0;
  // place her directly ahead of wherever the camera is looking, close up
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward); forward.y = 0; forward.normalize();
  const sp = lady.mesh.position;
  sp.copy(playerPos).addScaledVector(forward, 1.8);
  lady.mesh.visible = true;
  lady.mesh.lookAt(playerPos.x, sp.y, playerPos.z);

  playJumpscareSting();
  showHorrorFace();
  shakeScreen();
}

function endLadyScare(){
  lady.scareActive = false;
  lady.mesh.visible = false;
}

// Fullscreen horror-face flash overlay.
function showHorrorFace(){
  const el = document.getElementById('jumpscareOverlay');
  if (!el) return;
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'), 1400);
}

// Screen vibrates left/right while the scare music plays.
function shakeScreen(){
  const el = document.body;
  el.classList.add('screenShake');
  setTimeout(()=>el.classList.remove('screenShake'), 1400);
}

// Any touch is instant game over in every mode except Practice. Practice never
// activates a threat, so this function simply never fires there.
function catchPlayer(byLady=false, byGrandman=false){
  if (!GAME.running) return;
  GAME.running = false;
  controls.unlock();
  setHeartbeat(false);
  playCaught();
  let text = 'CAUGHT BY GRANDMA — GAME OVER';
  if (byLady) text = 'LADY GOT YOU';
  if (byGrandman) text = "GRANDMAN'S SHOTGUN GOT YOU";
  document.getElementById('killText').textContent = text;
  document.getElementById('killScreen').classList.remove('hidden');
}

/* =========================================================
   INPUT
========================================================= */
function onKeyDown(e){
  // While seated in the rocket, keys drive the cockpit (place items / ignite) instead of movement.
  if (rocketSeated){
    if (!cockpit.launching){
      if (e.code === 'Digit1') placeCockpitItem('key');
      if (e.code === 'Digit2') placeCockpitItem('fuel');
      if (e.code === 'KeyE') tryIgnite();
    }
    return;
  }
  switch(e.code){
    case 'KeyW': move.f = true; break;
    case 'KeyS': move.b = true; break;
    case 'KeyA': move.l = true; break;
    case 'KeyD': move.r = true; break;
    case 'ShiftLeft': case 'ShiftRight': move.sprint = true; break;
    case 'KeyC': case 'ControlLeft': move.crouch = !move.crouch; break;
    case 'KeyE': tryInteractNearest(); break;
  }
}
function onKeyUp(e){
  switch(e.code){
    case 'KeyW': move.f = false; break;
    case 'KeyS': move.b = false; break;
    case 'KeyA': move.l = false; break;
    case 'KeyD': move.r = false; break;
    case 'ShiftLeft': case 'ShiftRight': move.sprint = false; break;
  }
}

/* =========================================================
   PROMPT + INTERACTION
========================================================= */
let promptTimer = null;
function showPrompt(text, duration=1200){
  const el = document.getElementById('promptText');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(promptTimer);
  promptTimer = setTimeout(()=>el.classList.remove('show'), duration);
}

let nearestInteractable = null;
function updateNearestInteractable(playerPos){
  let best = null, bestDist = Infinity;
  interactables.forEach(it=>{
    if (it.type === 'mainDoor' && GAME.mainDoorOpen) return; // door already open, nothing to prompt
    const d = it.obj.position.distanceTo(playerPos);
    if (d < it.range && d < bestDist){ bestDist = d; best = it; }
  });
  nearestInteractable = best;
  const el = document.getElementById('promptText');
  if (best){
    el.textContent = best.prompt;
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}
function tryInteractNearest(){
  if (nearestInteractable) nearestInteractable.onInteract();
}

/* =========================================================
   MOVEMENT + COLLISION (per-floor aware)
========================================================= */
function collidesAt(x,z){
  const r = 0.35;
  // on the stairs, bypass wall collision entirely so the transition is smooth
  if (stairProgress(x,z) !== null) return false;

  const testBox = new THREE.Box3(
    new THREE.Vector3(x-r, 0.2, z-r),
    new THREE.Vector3(x+r, 1.6, z+r)
  );
  for (const c of colliders){
    if (c.floor !== GAME.floor) continue;
    if (testBox.intersectsBox(c.box)) return true;
  }
  // house bounds — only the corridor through the main door/rocket yard is open
  if (Math.abs(x) > 20.4 && z < 25) return true;
  return false;
}

function updateMovement(dt){
  const obj = controls.getObject();
  playerHeight = move.crouch ? playerHeightCrouch : playerHeightStand;

  const diff = DIFFICULTY[GAME.mode];
  let baseSpeed = move.crouch ? 1.6 : 3.4;
  let sprinting = move.sprint && !move.crouch && stamina > 0;
  if (sprinting) baseSpeed *= 1.7;

  // stamina
  if (sprinting){ stamina = Math.max(0, stamina - dt*28); }
  else { stamina = Math.min(100, stamina + dt*14); }
  document.getElementById('staminaBar').style.width = stamina + '%';
  document.getElementById('staminaBar').style.background = stamina < 25 ? '#ff5b5b' : '#7fffb0';

  // noise level (affects grandma's hearing range multiplier)
  noiseLevel = move.crouch ? 0.15 : (sprinting ? 1.0 : 0.5);
  if (!move.f && !move.b && !move.l && !move.r) noiseLevel = 0.05;

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward); forward.y = 0; forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();

  let dx=0, dz=0;
  if (move.f){ dx += forward.x; dz += forward.z; }
  if (move.b){ dx -= forward.x; dz -= forward.z; }
  if (move.r){ dx += right.x; dz += right.z; }
  if (move.l){ dx -= right.x; dz -= right.z; }

  // Virtual joystick (Android): x = strafe, y = forward(-1)/back(1)
  if (GAME.platform === 'android' && (joyVec.x !== 0 || joyVec.y !== 0)){
    dx += right.x*joyVec.x - forward.x*joyVec.y;
    dz += right.z*joyVec.x - forward.z*joyVec.y;
  }

  const len = Math.hypot(dx,dz);
  if (len > 0){ dx/=len; dz/=len; }

  const nx = obj.position.x + dx*baseSpeed*dt;
  const nz = obj.position.z + dz*baseSpeed*dt;

  if (!collidesAt(nx, obj.position.z)) obj.position.x = nx;
  if (!collidesAt(obj.position.x, nz)) obj.position.z = nz;

  // stairs: interpolate vertical offset based on progress along the ramp footprint
  const prog = stairProgress(obj.position.x, obj.position.z);
  if (prog !== null){
    floorBaseY = prog * WALL_H;
    GAME.floor = prog > 0.5 ? 1 : 0;
  } else {
    floorBaseY = GAME.floor * WALL_H;
  }
  obj.position.y += (floorBaseY + playerHeight - obj.position.y) * Math.min(1, dt*8);

  // footstep sfx
  if (len > 0){
    AUDIO.footTimer -= dt;
    if (AUDIO.footTimer <= 0){
      playFootstep();
      AUDIO.footTimer = sprinting ? 0.28 : (move.crouch ? 0.55 : 0.42);
    }
  }
}

/* =========================================================
   LAUNCH SEQUENCE (rocket ride + moon/earth view + parachute into a forest)
========================================================= */
function beginLaunchSequence(){
  rocketSeated = true;
  GAME.running = false;
  showPrompt('', 1);
  document.getElementById('promptText').classList.remove('show');

  const obj = controls.getObject();
  const startY = obj.position.y;
  const rocketBase = rocketBodyGroup.position.clone();
  let t = 0;
  const seatDuration = 1.2;

  function seatAnim(){
    t += 0.016;
    const p = Math.min(1, t/seatDuration);
    obj.position.lerpVectors(new THREE.Vector3(obj.position.x, startY, obj.position.z),
      new THREE.Vector3(rocketBase.x, 6.5, rocketBase.z), p);
    if (p < 1) requestAnimationFrame(seatAnim);
    else enterCockpit();
  }
  seatAnim();
}

function enterCockpit(){
  showPrompt('Place the items to prepare for launch. Look around — you can see out the window.', 3200);
  showCockpitPanel();
}

function launchCountdown(){
  let count = 3;
  showPrompt('Launching in ' + count + '...', 1100);
  const iv = setInterval(()=>{
    count--;
    if (count > 0) showPrompt('Launching in ' + count + '...', 1100);
    else { clearInterval(iv); liftOff(); }
  }, 1100);
}

function liftOff(){
  showPrompt('LIFTOFF! The Moon falls away on one side, Earth grows on the other...', 2600);
  playLaunch();
  const obj = controls.getObject();
  let t = 0;
  const ascendDuration = 7.0;
  const startPos = obj.position.clone();

  if (window.__moon) window.__moon.visible = true;

  function ascend(){
    t += 0.016;
    const p = Math.min(1, t/ascendDuration);
    const eased = p*p; // accelerate
    obj.position.y = startPos.y + eased*220;
    rocketBodyGroup.position.y = startPos.y - 6.5 + eased*220;
    camera.fov = 72 - eased*18;
    camera.updateProjectionMatrix();

    // Earth grows larger on one side of the view as we climb...
    if (window.__earth){
      window.__earth.position.y = 70 - eased*10;
      window.__earth.scale.setScalar(1 + eased*0.6);
    }
    // ...while the Moon's curved horizon recedes below/behind on the other side.
    if (window.__moon){
      window.__moon.position.y = -60 - eased*40;
    }

    if (p < 1) requestAnimationFrame(ascend);
    else showEarthView();
  }
  ascend();
}

function showEarthView(){
  showPrompt('Beautiful view — Earth ahead, the Moon receding behind. Look around.', 3400);
  let t = 0;
  function driftAscend(){
    t += 0.016;
    if (t < 4.5) requestAnimationFrame(driftAscend);
    else beginReentry();
  }
  driftAscend();
}

function beginReentry(){
  showPrompt('Entering Earth\'s gravity — hull heating up!', 2400);
  const obj = controls.getObject();
  let t = 0;
  const duration = 5.5;
  const startY = obj.position.y;

  const fireColor = new THREE.Color(0x552211);
  const skyColor = new THREE.Color(0x223355);
  scene.fog.color.copy(fireColor);
  scene.background = fireColor.clone();
  const fireEl = document.getElementById('reentryFire');
  fireEl.classList.add('active');
  fireEl.style.opacity = 1;

  if (window.__moon) window.__moon.visible = false;

  function fall(){
    t += 0.016;
    const p = Math.min(1, t/duration);
    obj.position.y = startY - p*p*160;

    fireEl.style.opacity = Math.max(0, 1 - p*1.3);
    if (p > 0.55){
      const bt = (p-0.55)/0.45;
      const blended = fireColor.clone().lerp(skyColor, bt);
      scene.fog.color.copy(blended);
      scene.background = blended;
    }

    if (p < 1) requestAnimationFrame(fall);
    else { fireEl.classList.remove('active'); fireEl.style.opacity = 0; beginParachute(); }
  }
  fall();
}

function beginParachute(){
  showPrompt('Parachute deployed! A forest below...', 2600);
  scene.background = new THREE.Color(0x89b8d9);
  scene.fog.color.set(0x89b8d9);
  scene.fog.density = 0.012;
  buildForest();
  const obj = controls.getObject();
  let t = 0;
  const duration = 6.0;
  const startY = obj.position.y;

  function glide(){
    t += 0.016;
    const p = Math.min(1, t/duration);
    obj.position.y = startY - p*40 + Math.sin(t*2)*0.3;
    obj.position.x += Math.sin(t*1.3)*0.03;
    if (p < 1) requestAnimationFrame(glide);
    else landed();
  }
  glide();
}

// A simple forest built from cones/cylinders around the Earth landing zone.
function buildForest(){
  const ground = new THREE.Mesh(new THREE.CircleGeometry(220, 32), matGrass);
  ground.rotation.x = -Math.PI/2;
  ground.position.y = -1;
  scene.add(ground);

  const trunkMat = new THREE.MeshStandardMaterial({color:0x5a3a22, roughness:0.9});
  const leafMat = new THREE.MeshStandardMaterial({color:0x2f6b34, roughness:0.85});
  for(let i=0;i<80;i++){
    const angle = Math.random()*Math.PI*2;
    const radius = 20 + Math.random()*180;
    const x = Math.cos(angle)*radius, z = Math.sin(angle)*radius;
    const h = 4 + Math.random()*4;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25,0.35,h,8), trunkMat);
    trunk.position.set(x, -1+h/2, z);
    scene.add(trunk);
    const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.6+Math.random(), 3.5+Math.random()*2, 10), leafMat);
    leaves.position.set(x, -1+h+1.4, z);
    scene.add(leaves);
  }
  const sun = new THREE.DirectionalLight(0xfff0d0, 1.2);
  sun.position.set(50,80,30);
  scene.add(sun);
}

function landed(){
  GAME.won = true;
  controls.unlock();
  playTone(523,0.2,'sine',0.2); setTimeout(()=>playTone(659,0.2,'sine',0.2),150); setTimeout(()=>playTone(784,0.4,'sine',0.22),300);
  document.getElementById('winScreen').classList.remove('hidden');
}

/* =========================================================
   MAIN LOOP
========================================================= */
function updateRocketCompass(playerPos){
  if (!rocketBodyGroup) return;
  const d = playerPos.distanceTo(rocketBodyGroup.position);
  const el = document.getElementById('rocketDist');
  if (el) el.textContent = Math.round(d) + 'm';
}

function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  const active = GAME.platform === 'pc' ? controls.isLocked : GAME.mobileActive;
  if (active && !rocketSeated){
    GAME.running = true;
    updateMovement(dt);
    const p = controls.getObject().position;
    updateNearestInteractable(p);
    updateGrandma(dt, p);
    updateGrandman(dt, p);
    updateLady(dt, p);
    updateRocketCompass(p);
  }

  if (rocketSeated){
    rocketBodyGroup.rotation.y += 0.001;
  }

  renderer.render(scene, camera);
}