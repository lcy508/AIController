import './style.css'
import * as THREE from 'three'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
// Post-processing removed for stability

const container = document.getElementById('canvas-container')
const video = document.getElementById('webcam')
const colorPicker = document.getElementById('color-picker')
const fullscreenBtn = document.getElementById('fullscreen-btn')
const handStatus = document.getElementById('hand-status')
const shapeButtons = document.querySelectorAll('.shape-btn')
const cameraPreview = document.getElementById('camera-preview')
const restartBtn = document.getElementById('restart-camera-btn')
const manualSlider = document.getElementById('manual-spread')
const manualGroup = document.getElementById('manual-group')
const cameraSelect = document.getElementById('camera-select')
let currentDeviceId = ''
const overlay = document.getElementById('preview-overlay')
const overlayCtx = overlay ? overlay.getContext('2d') : null
let manualValue = manualSlider ? parseFloat(manualSlider.value) || 0 : 0
if (manualSlider) {
  manualSlider.addEventListener('input', (e) => {
    manualValue = parseFloat(e.target.value) || 0
  })
}

function isVideoReady(elem) {
  return !!(elem && elem.readyState >= 2 && elem.videoWidth > 0 && elem.videoHeight > 0)
}

function getDetectSource() {
  if (isVideoReady(cameraPreview)) return cameraPreview
  if (isVideoReady(video)) return video
  return null
}

async function waitForVideoReady(timeoutMs = 2000) {
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    if (getDetectSource()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return false
}

async function populateCameraList() {
  if (!cameraSelect || !navigator.mediaDevices?.enumerateDevices) return
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cams = devices.filter(d => d.kind === 'videoinput')
    const prev = cameraSelect.value
    cameraSelect.innerHTML = ''
    cams.forEach((d, idx) => {
      const opt = document.createElement('option')
      opt.value = d.deviceId
      opt.textContent = d.label || `Camera ${idx + 1}`
      cameraSelect.appendChild(opt)
    })
    // Select current if present
    const toSelect = (currentDeviceId && cams.some(c => c.deviceId === currentDeviceId)) ? currentDeviceId : (prev || (cams[0]?.deviceId || ''))
    if (toSelect) cameraSelect.value = toSelect
    // Bind change once
    if (!cameraSelect._bound) {
      cameraSelect.addEventListener('change', async () => {
        await startCamera(cameraSelect.value)
      })
      cameraSelect._bound = true
    }
  } catch (e) {
    console.warn('[camera] enumerateDevices failed', e)
  }
}

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
renderer.setClearColor(0x000000, 1)
renderer.toneMapping = THREE.ReinhardToneMapping
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
camera.position.set(0, 0, 2.5) // Move camera closer
let viewportHalf = 1.0

// Create group BEFORE setSize() so setSize can safely reference it
const group = new THREE.Group()
scene.add(group)

function setSize() {
  const w = container.clientWidth || window.innerWidth
  const h = container.clientHeight || window.innerHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  const gz = (typeof group !== 'undefined' && group && group.position) ? group.position.z : 0
  const dist = Math.max(0.0001, camera.position.z - gz)
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * dist
  const halfW = halfH * camera.aspect
  viewportHalf = Math.max(halfW, halfH)
  // Resize overlay canvas to match preview size for crisp landmark drawing
  if (overlay && cameraPreview) {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const rect = cameraPreview.getBoundingClientRect()
    overlay.width = Math.max(1, Math.round(rect.width * dpr))
    overlay.height = Math.max(1, Math.round(rect.height * dpr))
  }
}
setSize()
container.appendChild(renderer.domElement)

// (Post-processing disabled)

const PARTICLE_COUNT = 30000
const positions = new Float32Array(PARTICLE_COUNT * 3)
const targets = new Float32Array(PARTICLE_COUNT * 3)
const noise = new Float32Array(PARTICLE_COUNT * 3)
for (let i = 0; i < PARTICLE_COUNT; i++) {
  const i3 = i * 3
  positions[i3] = (Math.random() - 0.5) * 0.01
  positions[i3 + 1] = (Math.random() - 0.5) * 0.01
  positions[i3 + 2] = (Math.random() - 0.5) * 0.01
  let x = Math.random() * 2 - 1
  let y = Math.random() * 2 - 1
  let z = Math.random() * 2 - 1
  const len = Math.hypot(x, y, z) || 1
  x /= len; y /= len; z /= len
  noise[i3] = x
  noise[i3 + 1] = y
  noise[i3 + 2] = z
}

function createCircleTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const center = size / 2
  const radius = size / 2

  const gradient = ctx.createRadialGradient(center, center, 0, center, center, radius)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')

  ctx.beginPath()
  ctx.arc(center, center, radius, 0, Math.PI * 2)
  ctx.fillStyle = gradient
  ctx.fill()

  const texture = new THREE.CanvasTexture(canvas)
  return texture
}

const geometry = new THREE.BufferGeometry()
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
let particleColor = new THREE.Color(colorPicker?.value || '#ff0055')
const material = new THREE.PointsMaterial({
  size: 0.08,
  sizeAttenuation: true,
  color: particleColor,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  map: createCircleTexture(),
  alphaTest: 0.01
})
const points = new THREE.Points(geometry, material)
points.frustumCulled = false
group.add(points)

let currentShape = 'heart'
function setActiveButton(name) {
  shapeButtons.forEach(b => b.classList.toggle('active', b.dataset.shape === name))
}
setActiveButton(currentShape)

let shapeRadius = 0.8
function computeShapeRadiusFromTargets() {
  let r = 0
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3
    const x = targets[i3], y = targets[i3 + 1]
    const rr = Math.hypot(x, y)
    if (rr > r) r = rr
  }
  shapeRadius = r
}

function sampleHeart(out) {
  const n = PARTICLE_COUNT
  for (let i = 0; i < n; i++) {
    const t = (Math.random() * 2 - 1) * Math.PI
    const rr = Math.sqrt(Math.random())
    let x = 16 * Math.pow(Math.sin(t), 3)
    let y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    x *= rr; y *= rr
    x *= 1 / 18; y *= 1 / 18
    const z = (Math.random() - 0.5) * 0.15
    const i3 = i * 3
    out[i3] = x
    out[i3 + 1] = y
    out[i3 + 2] = z
  }
}

function sampleFlower(out, petals = 6) {
  const n = PARTICLE_COUNT
  for (let i = 0; i < n; i++) {
    const theta = Math.random() * Math.PI * 2
    const base = 0.5 + 0.5 * Math.max(0, Math.cos(petals * theta))
    const r = Math.pow(base, 0.7) * (0.6 + 0.4 * Math.random())
    const x = r * Math.cos(theta)
    const y = r * Math.sin(theta)
    const z = (Math.random() - 0.5) * 0.2
    const i3 = i * 3
    out[i3] = x
    out[i3 + 1] = y
    out[i3 + 2] = z
  }
}

function sampleSaturn(out) {
  const n = PARTICLE_COUNT
  const sphereCount = Math.floor(n * 0.6)
  const ringCount = n - sphereCount
  let i = 0
  for (; i < sphereCount; i++) {
    const i3 = i * 3
    const u = Math.random()
    const v = Math.random()
    const phi = 2 * Math.PI * u
    const cosTheta = 2 * v - 1
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta)
    const r = 0.6
    out[i3] = r * sinTheta * Math.cos(phi)
    out[i3 + 1] = r * cosTheta
    out[i3 + 2] = r * sinTheta * Math.sin(phi)
  }
  for (let j = 0; j < ringCount; j++, i++) {
    const i3 = i * 3
    const a = Math.random() * Math.PI * 2
    const R = 1.1
    const thickness = 0.07
    out[i3] = Math.cos(a) * R + (Math.random() - 0.5) * thickness
    out[i3 + 1] = (Math.random() - 0.5) * thickness * 0.6
    out[i3 + 2] = Math.sin(a) * R + (Math.random() - 0.5) * thickness
  }
}

function sampleFireworks(out) {
  const n = PARTICLE_COUNT
  const bursts = 12
  const dirs = new Array(bursts).fill(0).map(() => {
    let x = Math.random() * 2 - 1
    let y = Math.random() * 2 - 1
    let z = Math.random() * 2 - 1
    const l = Math.hypot(x, y, z) || 1
    return [x / l, y / l, z / l]
  })
  for (let i = 0; i < n; i++) {
    const i3 = i * 3
    const d = dirs[i % bursts]
    const r = Math.pow(Math.random(), 0.35)
    out[i3] = d[0] * r
    out[i3 + 1] = d[1] * r
    out[i3 + 2] = d[2] * r
  }
}

function sampleBuddha(out) {
  const n = PARTICLE_COUNT
  const headCount = Math.floor(n * 0.15)
  const bodyCount = Math.floor(n * 0.35)
  const baseCount = n - headCount - bodyCount

  let i = 0
  // Head
  for (let k = 0; k < headCount; k++, i++) {
    const i3 = i * 3
    const u = Math.random(), v = Math.random()
    const phi = 2 * Math.PI * u, theta = Math.acos(2 * v - 1)
    const r = 0.25
    out[i3] = r * Math.sin(theta) * Math.cos(phi)
    out[i3 + 1] = r * Math.sin(theta) * Math.sin(phi) + 0.5 // y offset
    out[i3 + 2] = r * Math.cos(theta)
  }
  // Body
  for (let k = 0; k < bodyCount; k++, i++) {
    const i3 = i * 3
    const u = Math.random(), v = Math.random()
    const phi = 2 * Math.PI * u, theta = Math.acos(2 * v - 1)
    const r = 0.4
    out[i3] = r * Math.sin(theta) * Math.cos(phi) * 1.2 // wider
    out[i3 + 1] = r * Math.sin(theta) * Math.sin(phi) * 0.9 // slightly squash
    out[i3 + 2] = r * Math.cos(theta) * 0.8
  }
  // Base (Legs/Lotus)
  for (let k = 0; k < baseCount; k++, i++) {
    const i3 = i * 3
    const u = Math.random(), v = Math.random()
    const phi = 2 * Math.PI * u, theta = Math.acos(2 * v - 1)
    const r = 0.6
    out[i3] = r * Math.sin(theta) * Math.cos(phi) * 1.5
    out[i3 + 1] = r * Math.sin(theta) * Math.sin(phi) * 0.4 - 0.4 // flatten and move down
    out[i3 + 2] = r * Math.cos(theta) * 1.5
  }
}

function fillTargets(name) {
  if (name === 'heart') sampleHeart(targets)
  else if (name === 'flower') sampleFlower(targets, 7)
  else if (name === 'saturn') sampleSaturn(targets)
  else if (name === 'fireworks') sampleFireworks(targets)
  else if (name === 'buddha') sampleBuddha(targets)
  computeShapeRadiusFromTargets()
}
fillTargets(currentShape)

// Initialize current positions to targets so we see shape immediately
;(function initPositionsFromTargets() {
  const pos = geometry.attributes.position.array
  for (let i = 0; i < PARTICLE_COUNT * 3; i++) pos[i] = targets[i]
  geometry.attributes.position.needsUpdate = true
  geometry.computeBoundingSphere()
  computeShapeRadiusFromTargets()
})()

shapeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.shape
    currentShape = name
    setActiveButton(name)
    fillTargets(name)
  })
})

if (colorPicker) {
  colorPicker.addEventListener('input', (e) => {
    const v = e.target.value
    particleColor.set(v)
    material.color = particleColor
    document.documentElement.style.setProperty('--primary-color', v)
  })
}

if (fullscreenBtn) {
  fullscreenBtn.addEventListener('click', () => {
    const elem = document.fullscreenElement
    if (elem) document.exitFullscreen()
    else (container.requestFullscreen ? container.requestFullscreen() : document.body.requestFullscreen())
  })
}

window.addEventListener('resize', setSize)

let handLandmarker = null
let openness = 0
let handsDetected = 0
const openSmooth = 0.18

async function initHands() {
  if (handStatus) handStatus.textContent = 'Loading hand model...'
  const wasmPaths = [
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  ]
  let lastErr = null
  for (const p of wasmPaths) {
    try {
      console.log('[hands] trying wasm from', p)
      const fileset = await FilesetResolver.forVisionTasks(p)
      handLandmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4
      })
      console.log('[hands] model loaded')
      if (handStatus) handStatus.textContent = 'Hand model loaded. Raise your hands.'
      return
    } catch (e) {
      console.error('[hands] load failed at', p, e)
      lastErr = e
    }
  }
  if (handStatus) handStatus.textContent = 'Failed to load hand model'
  throw lastErr
}

let cameraRetryTimer = null
let cameraRetries = 0
const MAX_CAMERA_RETRIES = 3

function stopCamera() {
  const stopTracks = (elem) => {
    const s = elem && elem.srcObject
    if (s && s.getTracks) s.getTracks().forEach(t => t.stop())
    if (elem) elem.srcObject = null
  }
  stopTracks(video)
  stopTracks(cameraPreview)
}

async function startCamera(preferredDeviceId = '') {
  if (handStatus) handStatus.textContent = 'Requesting camera...'
  try {
    const tryConstraints = async (constraints) => {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints)
      } catch (e) {
        console.warn('[camera] constraints failed', constraints, e)
        return null
      }
    }

    let stream = null
    const constraintsList = []
    if (preferredDeviceId) {
      constraintsList.push({ video: { deviceId: { exact: preferredDeviceId } }, audio: false })
    }
    constraintsList.push(
      { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: true, audio: false }
    )
    for (const c of constraintsList) {
      stream = await tryConstraints(c)
      if (stream) break
    }

    if (!stream) {
      // Try picking the first available video input device explicitly
      const devices = await navigator.mediaDevices.enumerateDevices()
      const cam = devices.find(d => d.kind === 'videoinput')
      if (cam && cam.deviceId) {
        stream = await tryConstraints({ video: { deviceId: { exact: cam.deviceId } }, audio: false })
      }
    }

    if (!stream) throw new Error('No camera stream available')

    // Stop any previous stream before attaching
    stopCamera()

    // Attach to hidden detector video and visible preview
    video.srcObject = stream
    video.muted = true
    // @ts-ignore
    video.playsInline = true
    if (cameraPreview) {
      cameraPreview.srcObject = stream
      cameraPreview.muted = true
      // @ts-ignore
      cameraPreview.playsInline = true
    }

    await new Promise(r => { video.onloadedmetadata = () => r() })
    try { await video.play() } catch (e) { console.warn('[camera] play(video) failed', e) }
    if (cameraPreview) { try { await cameraPreview.play() } catch (e) { console.warn('[camera] play(preview) failed', e) } }

    // Ensure overlay matches preview
    setSize()

    // Wait briefly until one video element reports dimensions
    await waitForVideoReady(3000)

    // Remember current deviceId if available
    try {
      const track = stream.getVideoTracks()[0]
      const settings = track && track.getSettings ? track.getSettings() : {}
      currentDeviceId = settings.deviceId || preferredDeviceId || currentDeviceId
    } catch {}

    if (handStatus) handStatus.textContent = `Camera ready (${video.videoWidth}x${video.videoHeight})`
    // Populate camera list after permission granted
    await populateCameraList()
    cameraRetries = 0
    return true
  } catch (e) {
    console.warn('[camera] getUserMedia failed', e)
    if (handStatus) handStatus.textContent = 'Camera unavailable. Click "重启摄像头"'
    if (cameraRetries < MAX_CAMERA_RETRIES) {
      clearTimeout(cameraRetryTimer)
      const delay = 1500 * (cameraRetries + 1)
      cameraRetryTimer = setTimeout(() => { cameraRetries++; startCamera() }, delay)
    }
    return false
  }
}

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0)
  return Math.hypot(dx, dy, dz)
}

function computeOpenness(landmarks) {
  if (!landmarks || !landmarks.length) return { norm: 0, avg: 0 }
  // 更稳健：使用指骨段长度比例，TIP->PIP / PIP->MCP，天然尺寸归一
  const lm = landmarks[0]
  const pairs = [
    { tip: 8, pip: 6, mcp: 5 },   // index
    { tip: 12, pip: 10, mcp: 9 }, // middle
    { tip: 16, pip: 14, mcp: 13 },// ring
    { tip: 20, pip: 18, mcp: 17 } // pinky
  ]
  let sum = 0
  let cnt = 0
  for (const p of pairs) {
    const tipLen = dist(lm[p.tip], lm[p.pip])
    const baseLen = Math.max(1e-6, dist(lm[p.pip], lm[p.mcp]))
    let r = tipLen / baseLen
    // clamp
    r = Math.max(0, Math.min(1, r))
    sum += r
    cnt++
  }
  // 可选：加入拇指，稳定性略差，权重同等
  const tipLenT = dist(lm[4], lm[3])
  const baseLenT = Math.max(1e-6, dist(lm[3], lm[2]))
  let rT = Math.max(0, Math.min(1, tipLenT / baseLenT))
  sum += rT
  cnt++
  const avg = cnt ? (sum / cnt) : 0
  const norm = Math.max(0, Math.min(1, avg))
  return { norm, avg }
}

function drawOverlay(landmarks) {
  if (!overlayCtx || !overlay || !cameraPreview) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = overlay.width / dpr
  const h = overlay.height / dpr
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  overlayCtx.clearRect(0, 0, w, h)
  if (!landmarks || !landmarks.length) return
  const lm = landmarks[0]
  overlayCtx.save()
  // Mirror to match preview
  overlayCtx.translate(w, 0)
  overlayCtx.scale(-1, 1)
  overlayCtx.strokeStyle = 'rgba(255,255,255,0.7)'
  overlayCtx.fillStyle = 'rgba(255,0,85,0.9)'
  overlayCtx.lineWidth = 2
  const px = (x) => x * w
  const py = (y) => y * h
  // Draw points
  for (let i = 0; i < lm.length; i++) {
    const x = px(lm[i].x), y = py(lm[i].y)
    overlayCtx.beginPath()
    overlayCtx.arc(x, y, 3, 0, Math.PI * 2)
    overlayCtx.fill()
  }
  overlayCtx.restore()
}

function init() {
  // Start rendering immediately to avoid blank screen if model loading stalls
  setSize()
  renderer.setAnimationLoop(tick)
  startCamera()
    .then((ok) => initHands())
    .catch((e) => {
      if (handStatus) handStatus.textContent = `Init error: ${e?.message || e}`
    })
  if (manualGroup) manualGroup.style.display = 'block'
}

const morphSpeed = 0.1
const baseScale = 0.45

function updateHands() {
  if (!handLandmarker) {
    if (handStatus) handStatus.textContent = `Manual mode (no model). Spread: ${(manualValue * 100).toFixed(0)}%`
    if (manualGroup) manualGroup.style.display = 'block'
    openness = manualValue
    return
  }
  const src = getDetectSource()
  if (!src) {
    if (handStatus) handStatus.textContent = `Waiting for camera... Manual: ${(manualValue * 100).toFixed(0)}%`
    if (manualGroup) manualGroup.style.display = 'block'
    openness = manualValue
    if (video && video.paused) { video.play().catch(()=>{}) }
    return
  }
  if (manualGroup) manualGroup.style.display = 'none'
  const now = performance.now()
  let landmarks = []
  try {
    const res = handLandmarker.detectForVideo(src, now)
    landmarks = res && res.landmarks ? res.landmarks : []
  } catch (e) {
    console.warn('[hands] detect error, fallback to manual', e)
    openness = openness * (1 - openSmooth) + manualValue * openSmooth
    if (manualGroup) manualGroup.style.display = 'block'
    if (handStatus) handStatus.textContent = `Detect error. Manual: ${(manualValue * 100).toFixed(0)}%`
    return
  }
  handsDetected = landmarks.length
  // Draw overlay
  drawOverlay(landmarks)

  if (handsDetected === 0) {
    openness = openness * (1 - openSmooth) + manualValue * openSmooth
    if (handStatus) handStatus.textContent = `No hands. Manual: ${(manualValue * 100).toFixed(0)}%`
    if (manualGroup) manualGroup.style.display = 'block'
  } else {
    const { norm, avg } = computeOpenness(landmarks)
    openness = openness * (1 - openSmooth) + norm * openSmooth
    if (handStatus) handStatus.textContent = `Hands: ${handsDetected}  Open: ${(openness * 100).toFixed(0)}%`
  }
}

function tick() {
  updateHands()
  const s = 0.9 + openness * 0.8
  const neededSpreadToFill = Math.max(0, (viewportHalf / Math.max(0.001, baseScale * s)) - shapeRadius)
  const spread = Math.max(0, openness * neededSpreadToFill)
  group.scale.setScalar(baseScale * s)

  const pos = geometry.attributes.position.array
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3
    const tx = targets[i3] + noise[i3] * spread
    const ty = targets[i3 + 1] + noise[i3 + 1] * spread
    const tz = targets[i3 + 2] + noise[i3 + 2] * spread
    pos[i3] += (tx - pos[i3]) * morphSpeed
    pos[i3 + 1] += (ty - pos[i3 + 1]) * morphSpeed
    pos[i3 + 2] += (tz - pos[i3 + 2]) * morphSpeed
  }
  geometry.attributes.position.needsUpdate = true
  geometry.computeBoundingSphere()
  group.rotation.y += 0.002
  renderer.render(scene, camera)
}

if (restartBtn) {
  restartBtn.addEventListener('click', async () => {
    stopCamera()
    cameraRetries = 0
    const preferred = cameraSelect && cameraSelect.value ? cameraSelect.value : ''
    await startCamera(preferred)
    if (!handLandmarker) {
      try { await initHands() } catch (e) {}
    }
  })
}

init()
