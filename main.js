import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDParser } from 'three/addons/libs/mmdparser.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// Post-Processing Addons
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

// ========== SCENE SETUP ==========
const scene = new THREE.Scene();
scene.background = new THREE.Color('#050505');

// Ground grid for reference - helps see where the floor is
const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
gridHelper.position.y = 0;
scene.add(gridHelper);

// Ground plane (invisible shadow catcher)
const groundGeometry = new THREE.PlaneGeometry(20, 20);
const groundMaterial = new THREE.MeshBasicMaterial({ 
  color: 0x0a0a0a, 
  transparent: true, 
  opacity: 0.5,
  side: THREE.DoubleSide
});
const groundPlane = new THREE.Mesh(groundGeometry, groundMaterial);
groundPlane.rotation.x = -Math.PI / 2;
groundPlane.position.y = -0.01; // Slightly below grid
scene.add(groundPlane);

const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.3, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
// Performance: Cap pixel ratio to 2.0 to prevent lag on 4K/high-DPI screens
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.0));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.getElementById('app-container').appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);

// ========== POST-PROCESSING (GPU) ==========
const renderScene = new RenderPass(scene, camera);

// Subtle Bloom - reduced for better detail visibility
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.05, 0.2, 0.85);

// MSAA Render Target (WebGL2 native anti-aliasing)
// This is the "secret sauce" for crisp edges with post-processing
const renderTarget = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
  type: THREE.HalfFloatType,
  samples: 4 // 4x MSAA
});

const composer = new EffectComposer(renderer, renderTarget);
composer.addPass(renderScene);
composer.addPass(bloomPass);

// FXAA Pass (Fast Approximate Anti-Aliasing) - secondary smoothing
const fxaaPass = new ShaderPass(FXAAShader);
fxaaPass.material.uniforms['resolution'].value.x = 1 / (innerWidth * renderer.getPixelRatio());
fxaaPass.material.uniforms['resolution'].value.y = 1 / (innerHeight * renderer.getPixelRatio());
composer.addPass(fxaaPass);

// OutputPass handles final color space conversion
const outputPass = new OutputPass();
composer.addPass(outputPass);

// ========== GLOBAL STATE & PERSISTENCE ==========
let lastAnimFile = null;
let lastAnimType = null;
let lastAnimName = "";

function disposeCurrentMixer() {
  if (currentAction) {
    currentAction.stop();
    currentAction = null;
  }
  if (mixer) {
    mixer.stopAllAction();
    // mixer.uncacheRoot(vrm?.scene || genericModel || mmd);
    mixer = null;
  }
}

async function rebindLastAnimation() {
  if (!lastAnimFile) return;
  console.log('[Persistence] Re-binding last animation:', lastAnimName);
  
  const url = URL.createObjectURL(lastAnimFile);
  try {
    if (lastAnimType === 'fbx') {
      if (modelType === 'vrm') await loadFBXForVRM(url, false);
      else if (genericModel) await loadFBXForGeneric(url, false);
    }
    else if (lastAnimType === 'vrma') await loadVRMA(url, false);
    else if (lastAnimType === 'vmd') {
      if (modelType === 'mmd') await loadVMDNative(lastAnimFile, false);
      else if (modelType === 'vrm') await loadVMDRetarget(lastAnimFile, false);
    }
  } catch (err) {
    console.warn('[Persistence] Re-bind failed:', err.message);
  } finally {
    URL.revokeObjectURL(url);
  }
}
scene.add(new THREE.AmbientLight(0xffffff, 1.5));
{
  const dirLight = new THREE.DirectionalLight(0xffffff, 2);
  dirLight.position.set(2, 3, 1);
  scene.add(dirLight);
}

// ========== STATE ==========
let vrm = null;
let mmd = null;  // MMD model (for native VMD playback)
let genericModel = null; // glTF/GLB/FBX generic models
let modelType = null; // 'vrm' | 'mmd' | 'generic'
let mixer = null;
let currentAction = null;
const clock = new THREE.Clock();

// ========== ANIME FACE EXPRESSION SYSTEM ==========
const faceExpressions = {
  // Blink state
  blinkState: 'open', // 'open', 'closing', 'closed', 'opening'
  blinkTimer: 0,
  nextBlinkTime: Math.random() * 3 + 2, // 2-5 seconds
  blinkDuration: 0.15, // How long eyes stay closed
  
  // Eye tracking
  lookAtTarget: new THREE.Vector3(0, 1.5, 5),
  lookAtSmooth: new THREE.Vector3(0, 1.5, 5),
  mouseTracking: true,
  
  // Breathing/mouth
  breathTime: 0,
  mouthOpenness: 0,
  
  // Current expression weights (0-1)
  expressions: {
    neutral: 1,
    happy: 0,
    sad: 0,
    angry: 0,
    surprised: 0,
    blink: 0,
    winkLeft: 0,
    winkRight: 0
  },
  
  // Expression transition
  targetExpression: 'neutral',
  transitionSpeed: 0.1
};

// Mouse tracking for eye look
const mouse = new THREE.Vector2();
const windowHalfX = window.innerWidth / 2;
const windowHalfY = window.innerHeight / 2;

// Eye tracking offset correction (adjust if eyes look too high/low)
const eyeTrackingOffset = { x: 0, y: 0.3 }; // y: positive = look down more

// Track mouse for eye look-at
document.addEventListener('mousemove', (event) => {
  mouse.x = (event.clientX - windowHalfX) / 200; // Scale down for subtle movement
  mouse.y = (event.clientY - windowHalfY) / 200;
  
  // Limit range
  mouse.x = Math.max(-1, Math.min(1, mouse.x));
  mouse.y = Math.max(-1, Math.min(1, mouse.y));
});

// Update face expressions (call in animate loop)
function updateFaceExpressions(dt) {
  if (!vrm || !vrm.expressionManager) return;
  
  const expr = faceExpressions;
  const mgr = vrm.expressionManager;
  
  // ===== BLINK LOGIC =====
  expr.blinkTimer += dt;
  
  if (expr.blinkState === 'open' && expr.blinkTimer > expr.nextBlinkTime) {
    // Start blink
    expr.blinkState = 'closing';
    expr.blinkTimer = 0;
    expr.expressions.blink = 0;
  } else if (expr.blinkState === 'closing') {
    // Closing eyes
    const progress = expr.blinkTimer / (expr.blinkDuration * 0.3);
    expr.expressions.blink = Math.min(1, progress);
    if (progress >= 1) {
      expr.blinkState = 'closed';
      expr.blinkTimer = 0;
    }
  } else if (expr.blinkState === 'closed') {
    // Eyes closed briefly
    expr.expressions.blink = 1;
    if (expr.blinkTimer > expr.blinkDuration * 0.4) {
      expr.blinkState = 'opening';
      expr.blinkTimer = 0;
    }
  } else if (expr.blinkState === 'opening') {
    // Opening eyes
    const progress = expr.blinkTimer / (expr.blinkDuration * 0.3);
    expr.expressions.blink = Math.max(0, 1 - progress);
    if (progress >= 1) {
      expr.blinkState = 'open';
      expr.blinkTimer = 0;
      expr.nextBlinkTime = Math.random() * 3 + 2; // 2-5 seconds until next blink
      expr.expressions.blink = 0;
    }
  }
  
  // Apply blink
  mgr.setValue('blink', expr.expressions.blink);
  
  // ===== EYE, HEAD & BODY TRACKING =====
  if (expr.mouseTracking && vrm.lookAt) {
    // Ensure lookAt target exists
    if (!vrm.lookAt.target) {
      vrm.lookAt.target = new THREE.Object3D();
      vrm.lookAt.target.position.set(0, 1.5, 5);
    }
    
    // Calculate mouse distance from center (for body tilt)
    const mouseDistance = Math.sqrt(mouse.x * mouse.x + mouse.y * mouse.y);
    const mouseAngle = Math.atan2(mouse.y, mouse.x);
    
    // SIMPLE DIRECT EYE TRACKING
    // Map mouse position directly to look target in front of character
    const eyeRangeX = 2.0; // How far left/right eyes can look
    const eyeRangeY = 1.5; // How far up/down eyes can look
    const eyeDistance = 3.0; // Distance in front of character
    
    // Get base position (character position + eye height offset)
    const charPos = vrm.scene.position.clone();
    const eyeHeight = 1.5; // Approximate eye level
    
    // Calculate target based on mouse position
    // mouse.x is -1 to 1 (left to right), mouse.y is -1 to 1 (down to up)
    const targetX = charPos.x + (mouse.x * eyeRangeX);
    const targetY = charPos.y + eyeHeight + (mouse.y * eyeRangeY) + eyeTrackingOffset.y; // Removed negative
    const targetZ = charPos.z + eyeDistance;
    
    // Smooth interpolation
    expr.lookAtSmooth.x += (targetX - expr.lookAtSmooth.x) * 0.12;
    expr.lookAtSmooth.y += (targetY - expr.lookAtSmooth.y) * 0.12;
    expr.lookAtSmooth.z += (targetZ - expr.lookAtSmooth.z) * 0.12;
    
    // Apply to VRM lookAt (eyes)
    vrm.lookAt.target.position.copy(expr.lookAtSmooth);
    vrm.lookAt.update(dt);
    
    // ===== HEAD ROTATION (looks at precise raycast target) =====
    if (vrm.humanoid) {
      const head = vrm.humanoid.getNormalizedBoneNode('head');
      const neck = vrm.humanoid.getNormalizedBoneNode('neck');
      
      if (head) {
        // Calculate exact angle to look at the raycast target
        const headPos = new THREE.Vector3();
        head.getWorldPosition(headPos);
        
        // Direction to the look target
        const targetDir = new THREE.Vector3().subVectors(expr.lookAtSmooth, headPos).normalize();
        
        // Convert to local rotation
        const targetYaw = Math.atan2(targetDir.x, targetDir.z);
        const targetPitch = Math.asin(-targetDir.y);
        
        // Limit angles for subtle movement (reduced from 1.0/0.6 to 0.5/0.3)
        const clampedYaw = Math.max(-0.5, Math.min(0.5, targetYaw * 0.5)); // Half sensitivity
        const clampedPitch = Math.max(-0.3, Math.min(0.3, targetPitch * 0.5)); // Half sensitivity
        
        // Apply with smooth interpolation (slower: 0.08 instead of 0.12)
        head.rotation.y += (clampedYaw - head.rotation.y) * 0.08;
        head.rotation.x += (clampedPitch - head.rotation.x) * 0.08;
        
        // Add subtle head tilt when looking far left/right (anime style)
        head.rotation.z = -head.rotation.y * 0.2;
      }
      
      // Neck follows head (very subtle)
      if (neck) {
        const neckTargetY = head ? head.rotation.y * 0.4 : 0; // Reduced from 0.6
        const neckTargetX = head ? head.rotation.x * 0.4 : 0; // Reduced from 0.6
        neck.rotation.y += (neckTargetY - neck.rotation.y) * 0.05; // Slower
        neck.rotation.x += (neckTargetX - neck.rotation.x) * 0.05; // Slower
      }
    }
    
    // ===== BODY TILT (subtle, only when mouse far from center) =====
    if (vrm.humanoid && mouseDistance > 0.7) { // Higher threshold
      const spine = vrm.humanoid.getNormalizedBoneNode('spine');
      const hips = vrm.humanoid.getNormalizedBoneNode('hips');
      
      if (spine) {
        // Very subtle body lean
        const tiltAmount = Math.min((mouseDistance - 0.7) * 0.2, 0.15); // Reduced from 0.4
        const targetZ = -mouse.x * tiltAmount * 0.4; // Reduced from 0.8
        const targetX = mouse.y * tiltAmount * 0.2; // Reduced from 0.5
        
        spine.rotation.z += (targetZ - spine.rotation.z) * 0.04; // Slower
        spine.rotation.x += (targetX - spine.rotation.x) * 0.04; // Slower
      }
      
      // Very subtle hips rotation
      if (hips) {
        const hipsTargetY = mouse.x * 0.15; // Reduced from 0.3
        hips.rotation.y += (hipsTargetY - hips.rotation.y) * 0.03; // Slower
      }
    }
  }
  
  // ===== BREATHING / MOUTH =====
  expr.breathTime += dt * 2; // Breathing speed
  const breath = Math.sin(expr.breathTime) * 0.5 + 0.5; // 0-1
  
  // Subtle mouth movement during breathing
  const mouthValue = breath * 0.15; // Very subtle
  mgr.setValue('aa', mouthValue);
  
  // ===== RESET ALL EXPRESSIONS FIRST =====
  // This ensures expressions disappear when sliders go to 0
  const allExpressions = [
    'neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised',
    'blink', 'blinkLeft', 'blinkRight',
    'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
    'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight',
    'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
    'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
    'eyeWideLeft', 'eyeWideRight',
    'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
    'jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthSmile', 'mouthSmirk',
    'mouthFrown', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
    'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
    'noseSneerLeft', 'noseSneerRight',
    'aa', 'ih', 'ou', 'ee', 'oh'
  ];
  allExpressions.forEach(expr => mgr.setValue(expr, 0));
  
  // ===== ANIME-STYLE EXPRESSIONS =====
  // Apply multi-blendshape combinations for dramatic anime expressions
  const animeMultiplier = 1.5; // Make expressions more extreme
  
  // Helper to apply expression with anime-style combination
  function applyAnimeExpression(name, blendshapes) {
    const intensity = (sliderValues[name] || 0) * animeMultiplier;
    if (intensity <= 0) return;
    
    // Apply each blendshape in the combination
    Object.entries(blendshapes).forEach(([shape, weight]) => {
      const current = mgr.getValue(shape) || 0;
      mgr.setValue(shape, Math.min(1, current + intensity * weight));
    });
  }
  
  // Base 6 - Classic expressions
  applyAnimeExpression('neutral', { neutral: 1.0 });
  applyAnimeExpression('happy', { 
    happy: 1.0, 
    eyeSquintRight: 0.3, 
    eyeSquintLeft: 0.3,
    cheekPuff: 0.2 
  });
  applyAnimeExpression('sad', { 
    sad: 1.0, 
    browInnerUp: 0.5,
    eyeWideRight: 0.2,
    eyeWideLeft: 0.2
  });
  applyAnimeExpression('angry', { 
    angry: 1.0, 
    browDownRight: 0.6, 
    browDownLeft: 0.6,
    eyeWideRight: 0.3,
    eyeWideLeft: 0.3
  });
  applyAnimeExpression('surprised', { 
    surprised: 1.0, 
    eyeWideRight: 0.8, 
    eyeWideLeft: 0.8,
    jawOpen: 0.3,
    browInnerUp: 0.5
  });
  applyAnimeExpression('relaxed', { 
    relaxed: 1.0, 
    eyeBlinkRight: 0.1, 
    eyeBlinkLeft: 0.1 
  });
  
  // Row 2 - Emotional
  applyAnimeExpression('shy', { 
    happy: 0.3,
    eyeLookDownRight: 0.4, 
    eyeLookDownLeft: 0.4,
    cheekPuff: 0.5,
    mouthSmile: 0.2
  });
  applyAnimeExpression('smug', { 
    happy: 0.4,
    browOuterUpRight: 0.4,
    browOuterUpLeft: 0.2,
    mouthSmirk: 0.6
  });
  applyAnimeExpression('sob', { 
    sad: 0.8, 
    eyeWideRight: 0.3, 
    eyeWideLeft: 0.3,
    mouthFrown: 0.5,
    browInnerUp: 0.7
  });
  applyAnimeExpression('annoyed', { 
    angry: 0.5,
    browDownRight: 0.3, 
    browDownLeft: 0.3,
    mouthPucker: 0.3,
    eyeLookUpRight: 0.2,
    eyeLookUpLeft: 0.2
  });
  applyAnimeExpression('love', { 
    happy: 0.6, 
    eyeWideRight: 0.4, 
    eyeWideLeft: 0.4,
    cheekPuff: 0.6,
    mouthSmile: 0.5,
    heart: 1.0
  });
  applyAnimeExpression('sleepy', { 
    eyeBlinkRight: 0.7, 
    eyeBlinkLeft: 0.7,
    mouthPucker: 0.2,
    browInnerUp: 0.1
  });
  
  // Row 3 - Character
  applyAnimeExpression('thinking', { 
    browOuterUpRight: 0.3,
    eyeLookUpRight: 0.3,
    eyeLookUpLeft: 0.3,
    mouthPucker: 0.2
  });
  applyAnimeExpression('pleading', { 
    sad: 0.5,
    eyeWideRight: 0.6, 
    eyeWideLeft: 0.6,
    browInnerUp: 0.8,
    mouthPucker: 0.3
  });
  applyAnimeExpression('huffy', { 
    angry: 0.6,
    cheekPuff: 0.8,
    mouthPucker: 0.4,
    browDownRight: 0.4,
    browDownLeft: 0.4
  });
  applyAnimeExpression('mischief', { 
    happy: 0.4,
    browOuterUpRight: 0.5,
    eyeWideRight: 0.2,
    mouthSmirk: 0.7
  });
  applyAnimeExpression('dizzy', { 
    eyeWideRight: 0.5, 
    eyeWideLeft: 0.5,
    browInnerUp: 0.3,
    mouthFrown: 0.2
  });
  applyAnimeExpression('faint', { 
    eyeBlinkRight: 1.0, 
    eyeBlinkLeft: 1.0,
    mouthPucker: 0.3,
    browInnerUp: 0.2
  });
  
  // Row 4 - Physical states
  applyAnimeExpression('sick', { 
    sad: 0.3,
    eyeWideRight: 0.2, 
    eyeWideLeft: 0.2,
    mouthFrown: 0.4,
    browInnerUp: 0.3
  });
  applyAnimeExpression('worried', { 
    sad: 0.4,
    browInnerUp: 0.6,
    eyeWideRight: 0.3,
    eyeWideLeft: 0.3,
    mouthPucker: 0.2
  });
  applyAnimeExpression('blank', { 
    neutral: 0.8,
    eyeBlinkRight: 0.1,
    eyeBlinkLeft: 0.1
  });
  applyAnimeExpression('innocent', { 
    happy: 0.3,
    eyeWideRight: 0.4, 
    eyeWideLeft: 0.4,
    browInnerUp: 0.2,
    mouthSmile: 0.3
  });
  applyAnimeExpression('cool', { 
    relaxed: 0.6,
    browOuterUpRight: 0.2,
    mouthSmirk: 0.3
  });
  applyAnimeExpression('crazy', { 
    happy: 0.5,
    eyeWideRight: 0.5, 
    eyeWideLeft: 0.5,
    mouthSmile: 0.7,
    browOuterUpRight: 0.4
  });
  
  // Row 5 - Social
  applyAnimeExpression('disappointed', { 
    sad: 0.6,
    mouthFrown: 0.5,
    browInnerUp: 0.3,
    eyeLookDownRight: 0.2,
    eyeLookDownLeft: 0.2
  });
  applyAnimeExpression('affection', { 
    happy: 0.5,
    eyeSquintRight: 0.3,
    eyeSquintLeft: 0.3,
    cheekPuff: 0.4,
    mouthSmile: 0.4
  });
  applyAnimeExpression('unamused', { 
    angry: 0.2,
    browDownRight: 0.3,
    browDownLeft: 0.3,
    mouthPucker: 0.3,
    eyeLookUpRight: 0.2,
    eyeLookUpLeft: 0.2
  });
}

// Helper to set expression
function setExpression(name, duration = 3000) {
  faceExpressions.targetExpression = name;
  
  // Auto-return to neutral after duration
  if (duration > 0) {
    setTimeout(() => {
      faceExpressions.targetExpression = 'neutral';
    }, duration);
  }
}

// ========== LOADERS ==========
const gltfLoader = new GLTFLoader();
gltfLoader.register(parser => new VRMLoaderPlugin(parser));
gltfLoader.register(parser => new VRMAnimationLoaderPlugin(parser));

const fbxLoader = new FBXLoader();
const mmdLoader = new MMDLoader();
let currentMMDManager = null; // Track MMD loading manager for texture cleanup

// Note: FBX files with complex morph targets may fail to load completely

// ========== CUSTOM FBX LOADER (with manager support) ==========
async function loadFBXWithMorphFix(url, manager) {
  // Fetch the FBX file
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  
  // Check format
  const header = new Uint8Array(arrayBuffer.slice(0, 20));
  const headerStr = String.fromCharCode.apply(null, header);
  const isBinary = headerStr.includes('Kaydara FBX Binary');
  console.log('[FBX Load] Format:', isBinary ? 'Binary' : 'ASCII');
  
  // Create blob from original data
  const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
  const blobUrl = URL.createObjectURL(blob);
  
  try {
    // Use the FBXLoader with the custom manager
    const loader = manager ? new FBXLoader(manager) : new FBXLoader();
    const result = await loader.loadAsync(blobUrl);
    return result;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

// Note: Morph target errors in FBXLoader are handled by the custom loader above

// ========== UI ELEMENTS ==========
const statusEl = document.getElementById('status');
const vrmInput = document.getElementById('vrm-input');
const mmdInput = document.getElementById('mmd-input');
const animInput = document.getElementById('anim-input');

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';
}

// Pixiv's complete Mixamo->VRM bone map (53 bones including fingers/toes)
const MIXAMO_VRM_RIG_MAP = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
  mixamorigLeftHandThumb2: 'leftThumbProximal',
  mixamorigLeftHandThumb3: 'leftThumbDistal',
  mixamorigLeftHandIndex1: 'leftIndexProximal',
  mixamorigLeftHandIndex2: 'leftIndexIntermediate',
  mixamorigLeftHandIndex3: 'leftIndexDistal',
  mixamorigLeftHandMiddle1: 'leftMiddleProximal',
  mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
  mixamorigLeftHandMiddle3: 'leftMiddleDistal',
  mixamorigLeftHandRing1: 'leftRingProximal',
  mixamorigLeftHandRing2: 'leftRingIntermediate',
  mixamorigLeftHandRing3: 'leftRingDistal',
  mixamorigLeftHandPinky1: 'leftLittleProximal',
  mixamorigLeftHandPinky2: 'leftLittleIntermediate',
  mixamorigLeftHandPinky3: 'leftLittleDistal',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigRightHandPinky1: 'rightLittleProximal',
  mixamorigRightHandPinky2: 'rightLittleIntermediate',
  mixamorigRightHandPinky3: 'rightLittleDistal',
  mixamorigRightHandRing1: 'rightRingProximal',
  mixamorigRightHandRing2: 'rightRingIntermediate',
  mixamorigRightHandRing3: 'rightRingDistal',
  mixamorigRightHandMiddle1: 'rightMiddleProximal',
  mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
  mixamorigRightHandMiddle3: 'rightMiddleDistal',
  mixamorigRightHandIndex1: 'rightIndexProximal',
  mixamorigRightHandIndex2: 'rightIndexIntermediate',
  mixamorigRightHandIndex3: 'rightIndexDistal',
  mixamorigRightHandThumb1: 'rightThumbMetacarpal',
  mixamorigRightHandThumb2: 'rightThumbProximal',
  mixamorigRightHandThumb3: 'rightThumbDistal',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
};

// ========== LOAD MMD (with textures) ==========
mmdInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  // Find the PMX/PMD file
  const pmxFile = files.find(f => f.name.match(/\.(pmx|pmd)$/i));
  if (!pmxFile) {
    setStatus('❌ No .pmx or .pmd file found!', 'error');
    return;
  }

  // Create file map for texture lookup
  const fileMap = {};
  const blobUrls = [];
  files.forEach(f => {
    const url = URL.createObjectURL(f);
    fileMap[f.name] = url;
    blobUrls.push(url);
  });

  // Cleanup previous MMD manager if exists
  if (currentMMDManager) {
    blobUrls.forEach(url => URL.revokeObjectURL(url));
  }

  // Custom loading manager for texture redirection
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    // Extract filename from URL
    const fileName = url.split('/').pop().split('\\').pop();
    if (fileMap[fileName]) return fileMap[fileName];
    
    // Try case-insensitive match
    const lowerFileName = fileName.toLowerCase();
    for (const [key, val] of Object.entries(fileMap)) {
      if (key.toLowerCase() === lowerFileName) return val;
    }
    return url;
  });

  currentMMDManager = manager;
  const mmdLoaderWithTextures = new MMDLoader(manager);

  try {
    if (mixer) mixer.stopAllAction();
    currentAction = null;
    
    // Clear previous models
    if (vrm) { scene.remove(vrm.scene); vrm = null; }
    if (mmd) { scene.remove(mmd); mmd = null; }
    if (genericModel) { scene.remove(genericModel); genericModel = null; }

    modelType = 'mmd';
    setStatus('⏳ Loading MMD with textures...', 'info');

    mmd = await new Promise((resolve, reject) => {
      mmdLoaderWithTextures.load(
        fileMap[pmxFile.name],
        (object) => {
          console.log('[MMD] Loaded:', pmxFile.name);
          resolve(object);
        },
        (xhr) => {
          const percent = Math.floor((xhr.loaded / xhr.total) * 100);
          setStatus(`⏳ Loading ${percent}%...`, 'info');
        },
        (err) => {
          console.error('[MMD] Load error:', err);
          reject(err);
        }
      );
    });

    mmd.traverse(obj => {
      obj.frustumCulled = false;
      if (obj.material) obj.material.side = THREE.DoubleSide;
    });

    // Center the model
    const box = new THREE.Box3().setFromObject(mmd);
    const center = box.getCenter(new THREE.Vector3());
    mmd.position.x = -center.x;
    mmd.position.z = -center.z;
    mmd.position.y = -box.min.y; // Place on ground

    scene.add(mmd);
    setStatus('✅ MMD Model Loaded with Textures!', 'success');

  } catch (err) {
    console.error(err);
    setStatus('❌ MMD Load Error: ' + err.message, 'error');
    // Cleanup blob URLs
    blobUrls.forEach(url => URL.revokeObjectURL(url));
  }
});

// ========== LOAD AVATAR (VRM, glTF/GLB, or FBX with textures) ==========
vrmInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  // Find the model file (VRM, glTF, or FBX)
  const modelFile = files.find(f => f.name.match(/\.(vrm|glb|gltf|fbx)$/i));
  if (!modelFile) {
    setStatus('❌ No .vrm, .glb, .gltf, or .fbx file found!', 'error');
    return;
  }

  const ext = modelFile.name.split('.').pop().toLowerCase();
  
  // Create file map for texture lookup (for FBX)
  const fileMap = {};
  const blobUrls = [];
  files.forEach(f => {
    const url = URL.createObjectURL(f);
    fileMap[f.name] = url;
    blobUrls.push(url);
  });

  try {
    if (mixer) mixer.stopAllAction();
    currentAction = null;
    
    // Clear previous model
    if (vrm) { scene.remove(vrm.scene); vrm = null; }
    if (mmd) { scene.remove(mmd); mmd = null; }
    if (genericModel) { scene.remove(genericModel); genericModel = null; }

    if (ext === 'vrm') {
      // Load VRM (single file, no external textures needed)
      modelType = 'vrm';
      const gltf = await gltfLoader.loadAsync(fileMap[modelFile.name]);
      vrm = gltf.userData.vrm;
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      VRMUtils.combineSkeletons(vrm.scene);
      vrm.scene.traverse(obj => obj.frustumCulled = false);

      const normalizedRoot = vrm.humanoid?.normalizedHumanBonesRoot;
      if (normalizedRoot && !normalizedRoot.parent) {
        vrm.scene.add(normalizedRoot);
      }

      // Rotate VRM to face forward (back was facing camera)
      vrm.scene.rotation.y = Math.PI;
      
      scene.add(vrm.scene);
      setStatus('✅ VRM Avatar Loaded', 'success');
      
      // AUTO-REBIND last animation
      rebindLastAnimation();
      
    } else if (ext === 'glb' || ext === 'gltf') {
      // Load generic glTF/GLB
      modelType = 'generic';
      const gltf = await gltfLoader.loadAsync(fileMap[modelFile.name]);
      genericModel = gltf.scene;
      
      genericModel.traverse(obj => {
        obj.frustumCulled = false;
        if (obj.material) obj.material.side = THREE.DoubleSide;
      });
      
      // Auto-center and scale
      const box = new THREE.Box3().setFromObject(genericModel);
      const height = box.max.y - box.min.y;
      if (height > 0) {
        const scale = 1.6 / height;
        genericModel.scale.setScalar(scale);
      }
      
      scene.add(genericModel);
      setStatus('✅ glTF Model Loaded (Animation: use .fbx)', 'success');
      
    } else if (ext === 'fbx') {
      // Load FBX with texture support
      modelType = 'generic';
      
      // Debug: log what files we have
      console.log('[FBX Textures] Files in map:', Object.keys(fileMap));
      
      // Create loading manager for texture redirection
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        // Extract filename from URL (handles paths like "textures/Cloth.png" or "../Cloth.png")
        const fileName = url.split('/').pop().split('\\').pop();
        
        console.log('[FBX Texture] Looking for:', fileName, 'in map:', !!fileMap[fileName]);
        
        if (fileMap[fileName]) {
          console.log('[FBX Texture] Found! Returning blob URL');
          return fileMap[fileName];
        }
        
        // Case-insensitive match
        const lowerFileName = fileName.toLowerCase();
        for (const [key, val] of Object.entries(fileMap)) {
          if (key.toLowerCase() === lowerFileName) {
            console.log('[FBX Texture] Found (case-insensitive):', key);
            return val;
          }
        }
        
        console.warn('[FBX Texture] Not found in fileMap, returning original:', url);
        return url;
      });
      
      // Use custom FBX loader with manager for textures
      const fbx = await loadFBXWithMorphFix(fileMap[modelFile.name], manager);
      
      console.log('[FBX Model] Raw load result:', fbx?.type || typeof fbx, 'Keys:', Object.keys(fbx || {}));
      
      if (!fbx) throw new Error('FBX load failed - no data returned');
      
      // Handle various FBX return structures
      if (fbx.isObject3D || fbx.type === 'Group' || fbx.type === 'Object3D') {
        genericModel = fbx;
      } else if (fbx.scene && fbx.scene.isObject3D) {
        genericModel = fbx.scene;
      } else {
        console.error('[FBX Model] Unexpected structure:', fbx);
        throw new Error('FBX loaded but structure not recognized. Type: ' + (fbx?.type || typeof fbx));
      }
      
      if (!genericModel || !genericModel.traverse) {
        throw new Error('FBX has no valid 3D object or traverse method missing');
      }
      
      console.log('[FBX Model] Using:', genericModel.type || 'Object3D', 
                  'Children:', genericModel.children?.length,
                  'isObject3D:', genericModel.isObject3D);
      
      // Enable all materials for visibility
      genericModel.traverse(obj => {
        obj.frustumCulled = false;
        if (obj.material) {
          obj.material.side = THREE.DoubleSide;
          // Fix common FBX material issues
          if (obj.material.transparent && obj.material.opacity < 0.1) {
            obj.material.opacity = 1;
            obj.material.transparent = false;
          }
        }
      });
      
      // Smart auto-scale
      const box = new THREE.Box3().setFromObject(genericModel);
      const height = box.max.y - box.min.y;
      const width = box.max.x - box.min.x;
      const depth = box.max.z - box.min.z;
      console.log('[FBX Model] Dimensions:', { height: height.toFixed(2), width: width.toFixed(2), depth: depth.toFixed(2) });
      
      if (height > 0) {
        if (height < 0.5 || height > 5) {
          const targetHeight = 1.6;
          const scale = targetHeight / height;
          genericModel.scale.setScalar(scale);
          console.log('[FBX Model] Auto-scaled by', scale.toFixed(2));
        }
      }
      
      // Center the model
      const center = box.getCenter(new THREE.Vector3());
      genericModel.position.x = -center.x;
      genericModel.position.z = -center.z;
      genericModel.position.y = -box.min.y;
      
      scene.add(genericModel);
      setStatus(`✅ FBX Model Loaded (${height.toFixed(1)}m height)`, 'success');
      
      // AUTO-REBIND last animation
      rebindLastAnimation();
      
    } else {
      throw new Error(`Unsupported model format: .${ext}`);
    }
    
  } catch (err) {
    console.error('[FBX Load] Error:', err);
    console.error('[FBX Load] Stack:', err.stack);
    setStatus('❌ FBX Load Error: ' + err.message, 'error');
    // Cleanup blob URLs on error
    blobUrls.forEach(url => URL.revokeObjectURL(url));
  }
  // Note: Successful loads keep blob URLs alive for texture access
});

// ========== LOAD ANIMATION ==========
animInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || (!vrm && !mmd && !genericModel)) {
    setStatus('⚠️ Load avatar first!', 'error');
    return;
  }

  const ext = file.name.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(file);

  try {
    disposeCurrentMixer();

    if (ext === 'fbx') {
      if (modelType === 'vrm') await loadFBXForVRM(url);
      else if (genericModel) await loadFBXForGeneric(url);
      else throw new Error('FBX animation requires VRM or generic model with skeleton');
      
      lastAnimFile = file;
      lastAnimType = 'fbx';
    }
    else if (ext === 'vrma') {
       await loadVRMA(url);
       lastAnimFile = file;
       lastAnimType = 'vrma';
    }
    else if (ext === 'vmd') {
      if (modelType === 'mmd') await loadVMDNative(file);
      else if (modelType === 'vrm') await loadVMDRetarget(file);
      else throw new Error('VMD animations require MMD or VRM models.');
      
      lastAnimFile = file;
      lastAnimType = 'vmd';
    } else {
      throw new Error(`Unsupported format: .${ext}`);
    }
    
    lastAnimName = file.name;
    console.log('[Persistence] Saved animation state:', lastAnimName, lastAnimType);

    setStatus(`✅ ${ext.toUpperCase()} Playing`, 'success');
  } catch (err) {
    console.error(err);
    setStatus(`❌ ${ext.toUpperCase()} Error: ${err.message}`, 'error');
  } finally {
    URL.revokeObjectURL(url);
  }
});

// ── FBX Loader for VRM (Mixamo retarget) ──
async function loadFBXForVRM(url) {
  // Load FBX - may have warnings but should work
  let asset = await fbxLoader.loadAsync(url).catch(err => {
    console.warn('[FBX] Load warning:', err.message);
    // If we have partial data, try to use it
    if (err.target?.result) return err.target.result;
    throw err;
  });
  
  if (!asset) throw new Error('Failed to load FBX');
  
  // Handle case where asset doesn't have animations array
  if (!asset.animations) {
    asset.animations = [];
  }
  
  // Find the mixamo.com animation clip
  const clip = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') || asset.animations[0];
  if (!clip) throw new Error('No animation found in FBX');

  console.log('[FBX] clip name:', clip.name, 'duration:', clip.duration);
  console.log('[FBX] track samples:', clip.tracks.slice(0, 5).map(t => t.name));
  
  // Filter out morph target tracks AND eye/head/neck tracks (we control those manually)
  // NOTE: We keep SPINE animations intact so sitting/leaning animations work correctly
  const filteredTracks = clip.tracks.filter(t => {
    const name = t.name.toLowerCase();
    return name.includes('morph') || 
           name.includes('maniac') || 
           name.includes('deform') ||
           name.includes('eye') ||  // Skip eye bone animations
           name.includes('head') || // Skip head - we control it
           name.includes('neck') || // Skip neck - we control it
           // REMOVED: spine filtering - let animation control spine for proper sitting/leaning
           (!name.includes('.position') && !name.includes('.quaternion') && !name.includes('.scale'));
  });
  if (filteredTracks.length > 0) {
    console.log('[FBX] Skipping', filteredTracks.length, 'eye/head/neck/morph tracks (spine kept for animation)');
    clip.tracks = clip.tracks.filter(t => {
      const name = t.name.toLowerCase();
      return !name.includes('morph') && 
             !name.includes('maniac') && 
             !name.includes('deform') &&
             !name.includes('eye') &&
             !name.includes('head') &&
             !name.includes('neck');
             // REMOVED: !name.includes('spine') - keep spine animations
    });
  }

  const tracks = []; // KeyframeTracks compatible with VRM will be added here
  
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const _quatA = new THREE.Quaternion();
  const _vec3 = new THREE.Vector3();

  // Adjust with reference to hips height (crucial for proper scaling)
  const hipsNode = asset.getObjectByName('mixamorigHips');
  const motionHipsHeight = hipsNode?.position?.y || 1;
  const vrmHipsHeight = vrm.humanoid.normalizedRestPose.hips.position[1];
  const hipsPositionScale = vrmHipsHeight / motionHipsHeight;
  
  const isVrm0 = vrm?.meta?.metaVersion === '0';
  let mappedTrackCount = 0;

  clip.tracks.forEach((track) => {
    const trackSplitted = track.name.split('.');
    const mixamoRigName = trackSplitted[0];
    const vrmBoneName = MIXAMO_VRM_RIG_MAP[mixamoRigName];
    const vrmNodeName = vrm.humanoid?.getNormalizedBoneNode(vrmBoneName)?.name;
    const mixamoRigNode = asset.getObjectByName(mixamoRigName);

    if (vrmNodeName != null && mixamoRigNode) {
      const propertyName = trackSplitted[1];

      // Store rotations of rest-pose (crucial for retargeting)
      mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
      mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);

      if (track instanceof THREE.QuaternionKeyframeTrack) {
        // Retarget rotation of mixamoRig to NormalizedBone
        for (let i = 0; i < track.values.length; i += 4) {
          const flatQuaternion = track.values.slice(i, i + 4);
          _quatA.fromArray(flatQuaternion);
          
          // parentRestWorldRotation * trackRotation * restRotationInverse
          _quatA.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
          _quatA.toArray(flatQuaternion);
          
          flatQuaternion.forEach((v, index) => {
            track.values[index + i] = v;
          });
        }

        // Apply VRM0 coordinate fix (flip X/Z)
        const values = track.values.map((v, i) => (isVrm0 && i % 2 === 0 ? -v : v));
        tracks.push(new THREE.QuaternionKeyframeTrack(
          `${vrmNodeName}.${propertyName}`,
          track.times,
          values
        ));
        mappedTrackCount++;
      } else if (track instanceof THREE.VectorKeyframeTrack) {
        // Position tracks: scale and apply VRM0 coordinate fix
        const values = track.values.map((v, i) => {
          const axis = i % 3; // 0:x 1:y 2:z
          let val = v * hipsPositionScale;
          if (isVrm0 && axis !== 1) val = -val; // flip x and z for VRM0
          return val;
        });
        tracks.push(new THREE.VectorKeyframeTrack(
          `${vrmNodeName}.${propertyName}`,
          track.times,
          values
        ));
        mappedTrackCount++;
      }
    }
  });

  if (tracks.length === 0) {
    throw new Error('No compatible bones found. Make sure this is a Mixamo FBX.');
  }

  console.log('[FBX] mapped tracks:', mappedTrackCount, '/', clip.tracks.length);

  mixer = new THREE.AnimationMixer(vrm.scene);
  const newClip = new THREE.AnimationClip('vrmAnimation', clip.duration, tracks);
  currentAction = mixer.clipAction(newClip);
  currentAction.reset().play();
}

// ── FBX Loader for Generic Models (with auto bone name matching) ──
async function loadFBXForGeneric(url) {
  if (!genericModel) {
    throw new Error('No generic model loaded. Load a .fbx, .glb, or .gltf model first.');
  }
  
  let asset = await fbxLoader.loadAsync(url);
  
  // Handle different FBX return structures  
  const fbxObject = asset.isObject3D ? asset : asset.scene;
  
  const clip = fbxObject.animations?.[0] || asset.animations?.[0];
  if (!clip) throw new Error('No animation found in FBX');

  console.log('[FBX Generic] clip:', clip.name, 'duration:', clip.duration, 'tracks:', clip.tracks.length);
  
  // Collect model bones
  const modelBones = [];
  const modelBoneMap = {}; // name -> Bone object
  genericModel.traverse(obj => {
    if (obj.type === 'Bone' || obj.isBone) {
      modelBones.push(obj.name);
      modelBoneMap[obj.name] = obj;
    }
  });
  
  console.log('[FBX Generic] Model bones:', modelBones.slice(0, 20));
  console.log('[FBX Generic] Animation tracks:', clip.tracks.slice(0, 10).map(t => t.name));
  
  // Build auto-mapping from animation bones to model bones
  const boneNameMapping = buildBoneNameMapping(clip, modelBones);
  
  console.log('[FBX Generic] Auto-mapped bones:', Object.entries(boneNameMapping).slice(0, 10));
  
  // Remap animation tracks to match model bone names
  const remappedTracks = [];
  let matchedCount = 0;
  
  for (const track of clip.tracks) {
    const parts = track.name.split('.');
    const animBoneName = parts[0];
    const property = parts[1]; // position, quaternion, scale
    
    // Check direct match first
    let modelBoneName = modelBones.includes(animBoneName) ? animBoneName : null;
    
    // If no direct match, use our auto-mapping
    if (!modelBoneName && boneNameMapping[animBoneName]) {
      modelBoneName = boneNameMapping[animBoneName];
    }
    
    if (modelBoneName && modelBoneMap[modelBoneName]) {
      // Create new track with model's bone name
      const newTrackName = `${modelBoneName}.${property}`;
      let newTrack;
      
      if (track instanceof THREE.QuaternionKeyframeTrack) {
        newTrack = new THREE.QuaternionKeyframeTrack(newTrackName, track.times, track.values);
      } else if (track instanceof THREE.VectorKeyframeTrack) {
        newTrack = new THREE.VectorKeyframeTrack(newTrackName, track.times, track.values);
      } else {
        // Generic keyframe track
        newTrack = track.clone();
        newTrack.name = newTrackName;
      }
      
      remappedTracks.push(newTrack);
      matchedCount++;
    } else {
      console.log('[FBX Generic] Unmapped track:', track.name);
    }
  }
  
  console.log('[FBX Generic] Matched and remapped:', matchedCount, '/', clip.tracks.length);
  
  if (matchedCount === 0) {
    console.warn('[FBX Generic] No bones could be matched. Animation skeleton incompatible.');
    throw new Error(
      'Animation bone names do not match model.\n' +
      'Animation uses: ' + clip.tracks.slice(0, 5).map(t => t.name.split('.')[0]).join(', ') + '\n' +
      'Model has: ' + modelBones.slice(0, 5).join(', ') + '\n\n' +
      'Try using an animation with matching skeleton.'
    );
  }

  // Create new clip with remapped tracks
  const remappedClip = new THREE.AnimationClip(clip.name, clip.duration, remappedTracks);
  
  mixer = new THREE.AnimationMixer(genericModel);
  currentAction = mixer.clipAction(remappedClip);
  currentAction.reset().play();
  
  setStatus(`✅ FBX Animation Playing (${matchedCount}/${clip.tracks.length} bones mapped)`, 'success');
}

// Build automatic bone name mapping between animation and model
function buildBoneNameMapping(clip, modelBones) {
  const mapping = {};
  const animBones = [...new Set(clip.tracks.map(t => t.name.split('.')[0]))];
  
  // Common bone naming patterns and their equivalents
  const bonePatterns = [
    // Hips/Root
    { anim: ['Hips', 'mixamorigHips', ' hips', 'root', 'pelvis'], model: ['Hips', 'Root', 'hips', 'pelvis'] },
    // Spine
    { anim: ['Spine', 'mixamorigSpine', 'spine'], model: ['Spine', 'spine'] },
    { anim: ['Spine1', 'mixamorigSpine1', 'chest'], model: ['Chest', 'chest', 'spine1'] },
    { anim: ['Spine2', 'mixamorigSpine2', 'upperChest'], model: ['UpperChest', 'upperChest'] },
    // Head
    { anim: ['Head', 'mixamorigHead'], model: ['Head', 'head'] },
    { anim: ['Neck', 'mixamorigNeck'], model: ['Neck', 'neck'] },
    // Left Arm
    { anim: ['LeftShoulder', 'mixamorigLeftShoulder'], model: ['LeftShoulder', 'Left_shoulder', 'leftShoulder'] },
    { anim: ['LeftArm', 'mixamorigLeftArm', 'LeftUpperArm'], model: ['LeftArm', 'Left_arm', 'leftArm', 'LeftUpperArm'] },
    { anim: ['LeftForeArm', 'mixamorigLeftForeArm', 'LeftLowerArm'], model: ['LeftForeArm', 'Left_lowerArm', 'leftForeArm', 'LeftLowerArm'] },
    { anim: ['LeftHand', 'mixamorigLeftHand'], model: ['LeftHand', 'Left_hand', 'leftHand'] },
    // Right Arm
    { anim: ['RightShoulder', 'mixamorigRightShoulder'], model: ['RightShoulder', 'Right_shoulder', 'rightShoulder'] },
    { anim: ['RightArm', 'mixamorigRightArm', 'RightUpperArm'], model: ['RightArm', 'Right_arm', 'rightArm', 'RightUpperArm'] },
    { anim: ['RightForeArm', 'mixamorigRightForeArm', 'RightLowerArm'], model: ['RightForeArm', 'Right_lowerArm', 'rightForeArm', 'RightLowerArm'] },
    { anim: ['RightHand', 'mixamorigRightHand'], model: ['RightHand', 'Right_hand', 'rightHand'] },
    // Left Leg
    { anim: ['LeftUpLeg', 'mixamorigLeftUpLeg', 'LeftUpperLeg'], model: ['LeftUpLeg', 'Left_leg', 'leftUpLeg', 'LeftUpperLeg', 'Left_leg'] },
    { anim: ['LeftLeg', 'mixamorigLeftLeg', 'LeftLowerLeg'], model: ['LeftLeg', 'Left_knee', 'leftLeg', 'LeftLowerLeg', 'Left_knee'] },
    { anim: ['LeftFoot', 'mixamorigLeftFoot'], model: ['LeftFoot', 'Left_foot', 'leftFoot'] },
    { anim: ['LeftToeBase', 'mixamorigLeftToeBase'], model: ['LeftToeBase', 'LeftToes', 'leftToes'] },
    // Right Leg
    { anim: ['RightUpLeg', 'mixamorigRightUpLeg', 'RightUpperLeg'], model: ['RightUpLeg', 'Right_leg', 'rightUpLeg', 'RightUpperLeg', 'Right_leg'] },
    { anim: ['RightLeg', 'mixamorigRightLeg', 'RightLowerLeg'], model: ['RightLeg', 'Right_knee', 'rightLeg', 'RightLowerLeg', 'Right_knee'] },
    { anim: ['RightFoot', 'mixamorigRightFoot'], model: ['RightFoot', 'Right_foot', 'rightFoot'] },
    { anim: ['RightToeBase', 'mixamorigRightToeBase'], model: ['RightToeBase', 'RightToes', 'rightToes'] },
  ];
  
  for (const animBone of animBones) {
    if (modelBones.includes(animBone)) {
      // Direct match
      mapping[animBone] = animBone;
      continue;
    }
    
    // Try pattern matching
    for (const pattern of bonePatterns) {
      const animMatch = pattern.anim.some(a => 
        animBone.toLowerCase() === a.toLowerCase() ||
        animBone.toLowerCase().includes(a.toLowerCase())
      );
      
      if (animMatch) {
        // Find matching model bone
        for (const modelPattern of pattern.model) {
          const modelMatch = modelBones.find(mb => 
            mb.toLowerCase() === modelPattern.toLowerCase() ||
            mb.toLowerCase().includes(modelPattern.toLowerCase())
          );
          if (modelMatch) {
            mapping[animBone] = modelMatch;
            break;
          }
        }
        if (mapping[animBone]) break;
      }
    }
  }
  
  return mapping;
}

// BONE_MAP kept for VMD loader compatibility (different direction than MIXAMO_VRM_RIG_MAP)
const BONE_MAP = {
  hips: 'mixamorigHips', spine: 'mixamorigSpine', chest: 'mixamorigSpine1', 
  upperChest: 'mixamorigSpine2', neck: 'mixamorigNeck', head: 'mixamorigHead',
  leftShoulder: 'mixamorigLeftShoulder', leftUpperArm: 'mixamorigLeftArm', 
  leftLowerArm: 'mixamorigLeftForeArm', leftHand: 'mixamorigLeftHand',
  rightShoulder: 'mixamorigRightShoulder', rightUpperArm: 'mixamorigRightArm', 
  rightLowerArm: 'mixamorigRightForeArm', rightHand: 'mixamorigRightHand',
  leftUpperLeg: 'mixamorigLeftUpLeg', leftLowerLeg: 'mixamorigLeftLeg', leftFoot: 'mixamorigLeftFoot',
  rightUpperLeg: 'mixamorigRightUpLeg', rightLowerLeg: 'mixamorigRightLeg', rightFoot: 'mixamorigRightFoot'
};

// ── VRMA Loader (Native) ──
async function loadVRMA(url) {
  const gltf = await gltfLoader.loadAsync(url);
  const vrmAnim = gltf.userData.vrmAnimations?.[0];
  if (!vrmAnim) throw new Error('Invalid VRMA: missing VRMC_vrm_animation extension');

  const clip = createVRMAnimationClip(vrmAnim, vrm);
  mixer = new THREE.AnimationMixer(vrm.scene);
  currentAction = mixer.clipAction(clip);
  currentAction.play();
}

// ── VMD Loader (MMD) ──
// MMD bone name -> VRM bone name mapping
const MMD_TO_VRM_BONE_MAP = {
  'センター': 'hips',           // Center -> hips
  '上半身': 'spine',            // Upper body -> spine
  '上半身2': 'chest',           // Upper body 2 -> chest
  '首': 'neck',                 // Neck -> neck
  '頭': 'head',                 // Head -> head
  '左肩': 'leftShoulder',       // Left shoulder
  '左腕': 'leftUpperArm',       // Left arm
  '左ひじ': 'leftLowerArm',     // Left elbow
  '左手首': 'leftHand',         // Left wrist -> hand
  '左手': 'leftHand',           // Left hand (alternate)
  '右肩': 'rightShoulder',      // Right shoulder
  '右腕': 'rightUpperArm',      // Right arm
  '右ひじ': 'rightLowerArm',    // Right elbow
  '右手首': 'rightHand',        // Right wrist -> hand
  '右手': 'rightHand',          // Right hand (alternate)
  '左足': 'leftUpperLeg',       // Left leg
  '左ひざ': 'leftLowerLeg',     // Left knee
  '左足首': 'leftFoot',         // Left ankle
  '右足': 'rightUpperLeg',      // Right leg
  '右ひざ': 'rightLowerLeg',     // Right knee
  '右足首': 'rightFoot',        // Right ankle
  '下半身': 'hips',             // Lower body -> hips (position mainly)
  // Left fingers - thumb
  '左親指０': 'leftThumbMetacarpal',
  '左親指１': 'leftThumbProximal',
  '左親指２': 'leftThumbDistal',
  // Left fingers - index
  '左人指１': 'leftIndexProximal',
  '左人指２': 'leftIndexIntermediate',
  '左人指３': 'leftIndexDistal',
  // Left fingers - middle
  '左中指１': 'leftMiddleProximal',
  '左中指２': 'leftMiddleIntermediate',
  '左中指３': 'leftMiddleDistal',
  // Left fingers - ring
  '左薬指１': 'leftRingProximal',
  '左薬指２': 'leftRingIntermediate',
  '左薬指３': 'leftRingDistal',
  // Left fingers - pinky
  '左小指１': 'leftLittleProximal',
  '左小指２': 'leftLittleIntermediate',
  '左小指３': 'leftLittleDistal',
  // Right fingers - thumb
  '右親指０': 'rightThumbMetacarpal',
  '右親指１': 'rightThumbProximal',
  '右親指２': 'rightThumbDistal',
  // Right fingers - index
  '右人指１': 'rightIndexProximal',
  '右人指２': 'rightIndexIntermediate',
  '右人指３': 'rightIndexDistal',
  // Right fingers - middle
  '右中指１': 'rightMiddleProximal',
  '右中指２': 'rightMiddleIntermediate',
  '右中指３': 'rightMiddleDistal',
  // Right fingers - ring
  '右薬指１': 'rightRingProximal',
  '右薬指２': 'rightRingIntermediate',
  '右薬指３': 'rightRingDistal',
  // Right fingers - pinky
  '右小指１': 'rightLittleProximal',
  '右小指２': 'rightLittleIntermediate',
  '右小指３': 'rightLittleDistal',
  // Additional mappings from vrm-dance-viewer for better compatibility
  '全ての親': 'hips',           // Root parent -> hips
  'センター': 'hips',           // Center -> hips (position)
  '上半身': 'spine',            // Upper body -> spine
  '上半身2': 'chest',           // Upper body 2 -> chest
  '首': 'neck',                 // Neck
  '頭': 'head',                 // Head
  '左目': 'leftEye',            // Left eye
  '右目': 'rightEye',           // Right eye
  '左つま先': 'leftToes',       // Left toes
  '右つま先': 'rightToes',      // Right toes
};

// ── VMD Loader - NATIVE (for MMD models) ──
async function loadVMDNative(file) {
  const vmdUrl = URL.createObjectURL(file);
  
  try {
    // Use MMDLoader's built-in animation loading
    // This gives perfect compatibility since it's designed for MMD+VMD
    const vmdData = await new Promise((resolve, reject) => {
      const loader = new THREE.FileLoader();
      loader.setResponseType('arraybuffer');
      loader.load(vmdUrl, resolve, undefined, reject);
    });
    
    // Parse VMD
    const parser = new MMDParser.Parser();
    const vmd = parser.parseVmd(vmdData, true);
    
    console.log('[VMD Native] Parsed motions:', vmd.motions?.length);
    
    // Build animation clip using MMDLoader's animationBuilder
    const clip = mmdLoader.animationBuilder.build(vmd, mmd);
    
    console.log('[VMD Native] Clip:', clip.name, 'tracks:', clip.tracks.length);
    
    mixer = new THREE.AnimationMixer(mmd);
    currentAction = mixer.clipAction(clip);
    currentAction.reset().play();
    
    setStatus('✅ VMD Playing (Native MMD)', 'success');
  } finally {
    URL.revokeObjectURL(vmdUrl);
  }
}

// ── VMD Loader - RETARGET (for VRM models) ──
async function loadVMDRetarget(file) {
  const vmdUrl = URL.createObjectURL(file);
  const parser = new MMDParser.Parser();
  
  try {
    const vmdBuffer = await new Promise((resolve, reject) => {
      const loader = new THREE.FileLoader();
      loader.setResponseType('arraybuffer');
      loader.load(vmdUrl, resolve, undefined, reject);
    });
    
    const vmd = parser.parseVmd(vmdBuffer, true);
    console.log('[VMD Retarget] Parsed:', vmd);
    
    // Group motions by bone name
    const motionsByBone = {};
    for (const motion of vmd.motions || []) {
      const boneName = motion.boneName;
      if (!boneName) continue;
      if (!motionsByBone[boneName]) motionsByBone[boneName] = [];
      motionsByBone[boneName].push(motion);
    }
    
    console.log('[VMD Retarget] Unique bones:', Object.keys(motionsByBone));
    
    // Convert to VRM animation tracks
    const tracks = [];
    const timeScale = 30;
    
    // Early check - VMD retarget only works with VRM models
    if (!vrm || !vrm.humanoid) {
      throw new Error('VMD retarget requires a VRM model. Load a .vrm file first, or use an MMD model with VMD for native playback.');
    }
    
    for (const [mmdBoneName, motions] of Object.entries(motionsByBone)) {
      const vrmBoneName = MMD_TO_VRM_BONE_MAP[mmdBoneName];
      if (!vrmBoneName) {
        console.log('[VMD Retarget] Unmapped bone:', mmdBoneName);
        continue;
      }
      
    const node = vrm.humanoid?.getNormalizedBoneNode(vrmBoneName);
      if (!node) continue;
      
      motions.sort((a, b) => a.frameNum - b.frameNum);
      
      const times = [];
      const positions = [];
      const rotations = [];
      let hasPos = false;
      let hasRot = false;
      
      for (const m of motions) {
        const t = m.frameNum / timeScale;
        times.push(t);
        
        if (m.position) {
          const isVrm0 = vrm?.meta?.metaVersion === '0';
          const scale = 0.08;
          let x = m.position[0] * scale;
          let y = m.position[1] * scale;
          let z = m.position[2] * scale;
          if (isVrm0) { x = -x; z = -z; }
          positions.push(x, y, z);
          hasPos = true;
        }
        
        if (m.rotation) {
          const mmdQ = new THREE.Quaternion(m.rotation[0], m.rotation[1], m.rotation[2], m.rotation[3]);
          
          // Improved conversion for VRM 1.0/0.x humanoid norms
          // MMD: X:side, Y:up, Z:front. VRM: X:side, Y:up, Z:front (but normalized)
          let vrmQ;
          if (vrmBoneName === 'hips' || vrmBoneName.includes('spine') || vrmBoneName.includes('Chest')) {
            // Apply slight correction for spine-related bones to prevent asymmetric bending
            vrmQ = new THREE.Quaternion(-mmdQ.x, mmdQ.y, -mmdQ.z, mmdQ.w);
          } else {
            vrmQ = new THREE.Quaternion(-mmdQ.x, mmdQ.y, -mmdQ.z, mmdQ.w);
          }
          vrmQ.normalize();
          rotations.push(vrmQ.x, vrmQ.y, vrmQ.z, vrmQ.w);
          hasRot = true;
        }
      }
      
      if (hasRot) {
        tracks.push(new THREE.QuaternionKeyframeTrack(
          `${node.name}.quaternion`,
          times.slice(0, rotations.length / 4),
          rotations
        ));
      }
      
      if (hasPos) {
        tracks.push(new THREE.VectorKeyframeTrack(
          `${node.name}.position`,
          times.slice(0, positions.length / 3),
          positions
        ));
      }
    }
    
    console.log('[VMD Retarget] Created tracks:', tracks.length);
    
    if (tracks.length === 0) {
      throw new Error('No mappable VMD bones found');
    }
    
    const maxFrame = Math.max(...vmd.motions.map(m => m.frameNum));
    const duration = maxFrame / timeScale || 1;
    
    const clip = new THREE.AnimationClip('vmd_retarget', duration, tracks);
    
    mixer = new THREE.AnimationMixer(vrm.scene);
    currentAction = mixer.clipAction(clip);
    currentAction.reset().play();
    
    console.log('[VMD Retarget] Playing: duration:', duration, 'tracks:', tracks.length);
  } finally {
    URL.revokeObjectURL(vmdUrl);
  }
}

// ========== CONTROLS ==========
const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');

btnPlay.addEventListener('click', () => {
  if (currentAction) {
    currentAction.paused = false;
    currentAction.play();
    btnPlay.classList.add('active');
    btnPause.classList.remove('active');
    setStatus(`▶ Playing: ${lastAnimName || 'Animation'}`, 'success');
  } else {
    setStatus('⚠️ No animation loaded to play.', 'error');
  }
});

btnPause.addEventListener('click', () => {
  if (currentAction) {
    currentAction.paused = !currentAction.paused;
    if (currentAction.paused) {
      btnPause.classList.add('active');
      btnPlay.classList.remove('active');
      setStatus('⏸ Animation Paused', 'info');
    } else {
      btnPause.classList.remove('active');
      btnPlay.classList.add('active');
      setStatus('▶ Animation Resumed', 'success');
    }
  }
});

btnStop.addEventListener('click', () => {
  if (mixer) {
    mixer.stopAllAction();
    btnPlay.classList.remove('active');
    btnPause.classList.remove('active');
    setStatus('⏹ Animation Stopped', 'info');
  }
});

// ========== EXPRESSION SLIDER CONTROLS ==========
const sliderValues = {
  // Base 6
  neutral: 1, happy: 0, sad: 0, surprised: 0, angry: 0, relaxed: 0,
  // Row 2
  shy: 0, smug: 0, sob: 0, annoyed: 0, love: 0, sleepy: 0,
  // Row 3
  thinking: 0, pleading: 0, huffy: 0, mischief: 0, dizzy: 0, faint: 0,
  // Row 4
  sick: 0, worried: 0, blank: 0, innocent: 0, cool: 0, crazy: 0,
  // Row 5
  disappointed: 0, affection: 0, unamused: 0
};

function setupExpressionSlider(name) {
  const slider = document.getElementById('slider-' + name);
  const valDisplay = document.getElementById('val-' + name);
  
  if (slider && valDisplay) {
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      sliderValues[name] = val;
      valDisplay.textContent = val.toFixed(1);
      
      // Apply directly to VRM if loaded
      if (vrm && vrm.expressionManager) {
        vrm.expressionManager.setValue(name, val);
      }
    });
  }
}

// Setup all 27 expression sliders
// Base 6
setupExpressionSlider('neutral');
setupExpressionSlider('happy');
setupExpressionSlider('sad');
setupExpressionSlider('surprised');
setupExpressionSlider('angry');
setupExpressionSlider('relaxed');
// Row 2
setupExpressionSlider('shy');
setupExpressionSlider('smug');
setupExpressionSlider('sob');
setupExpressionSlider('annoyed');
setupExpressionSlider('love');
setupExpressionSlider('sleepy');
// Row 3
setupExpressionSlider('thinking');
setupExpressionSlider('pleading');
setupExpressionSlider('huffy');
setupExpressionSlider('mischief');
setupExpressionSlider('dizzy');
setupExpressionSlider('faint');
// Row 4
setupExpressionSlider('sick');
setupExpressionSlider('worried');
setupExpressionSlider('blank');
setupExpressionSlider('innocent');
setupExpressionSlider('cool');
setupExpressionSlider('crazy');
// Row 5
setupExpressionSlider('disappointed');
setupExpressionSlider('affection');
setupExpressionSlider('unamused');

// Eye tracking toggle
const chkEyeTracking = document.getElementById('chk-eye-tracking');
if (chkEyeTracking) {
  chkEyeTracking.addEventListener('change', (e) => {
    faceExpressions.mouseTracking = e.target.checked;
  });
}

// Eye Y-Offset slider
const sliderEyeOffset = document.getElementById('slider-eye-offset');
const valEyeOffset = document.getElementById('val-eye-offset');
if (sliderEyeOffset && valEyeOffset) {
  sliderEyeOffset.addEventListener('input', () => {
    const val = parseFloat(sliderEyeOffset.value);
    eyeTrackingOffset.y = val;
    valEyeOffset.textContent = val.toFixed(2);
  });
}

// ========== CHARACTER DRAG SYSTEM ==========
let isDraggingChar = false;
let dragStartPos = { x: 0, y: 0 };
let charStartPos = { x: 0, y: 0, z: 0 };

// Enable right-click drag to move character
renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault(); // Prevent default right-click menu
});

renderer.domElement.addEventListener('mousedown', (e) => {
  // Right mouse button (2) to drag character
  if (e.button === 2) {
    isDraggingChar = true;
    dragStartPos.x = e.clientX;
    dragStartPos.y = e.clientY;
    
    // Store current character position
    if (vrm && vrm.scene) {
      charStartPos.x = vrm.scene.position.x;
      charStartPos.y = vrm.scene.position.y;
      charStartPos.z = vrm.scene.position.z;
    } else if (genericModel) {
      charStartPos.x = genericModel.position.x;
      charStartPos.y = genericModel.position.y;
      charStartPos.z = genericModel.position.z;
    } else if (mmd) {
      charStartPos.x = mmd.position.x;
      charStartPos.y = mmd.position.y;
      charStartPos.z = mmd.position.z;
    }
    
    renderer.domElement.style.cursor = 'move';
  }
});

window.addEventListener('mouseup', () => {
  isDraggingChar = false;
  renderer.domElement.style.cursor = 'default';
});

window.addEventListener('mousemove', (e) => {
  if (!isDraggingChar) return;
  
  // Calculate drag delta based on camera distance
  const deltaX = (e.clientX - dragStartPos.x) * 0.01;
  const deltaY = -(e.clientY - dragStartPos.y) * 0.01; // Invert Y
  
  // Apply to character
  const targetModel = (vrm && vrm.scene) ? vrm.scene : (genericModel || mmd);
  if (targetModel) {
    targetModel.position.x = charStartPos.x + deltaX;
    targetModel.position.y = charStartPos.y + deltaY;
  }
});

// ========== LOOP ==========
function animate() {
  requestAnimationFrame(animate);
  
  // Clamp delta time to avoid physics "exploding" during frame drops (helps with smooth hair)
  const dt = Math.min(clock.getDelta(), 0.1);
  
  if (mixer && currentAction && !currentAction.paused) mixer.update(dt);
  if (vrm) vrm.update(dt);
  
  updateFaceExpressions(dt);
  
  controls.update();
  
  // Use Composer for Bloom effects (GPU)
  composer.render();
}
animate();

// ========== CAMERA FOCUS (Click on body part to focus there) ==========
const raycaster = new THREE.Raycaster();
const mouseClick = new THREE.Vector2();

// Shift + Click on character to focus camera on that point
renderer.domElement.addEventListener('click', (e) => {
  if (!e.shiftKey) return; // Only work with Shift+Click
  
  // Calculate mouse position in normalized device coordinates
  mouseClick.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseClick.y = -(e.clientY / window.innerHeight) * 2 + 1;
  
  raycaster.setFromCamera(mouseClick, camera);
  
  // Get the active model
  const targetModel = (vrm && vrm.scene) ? vrm.scene : (genericModel || mmd);
  if (!targetModel) return;
  
  // Raycast against the model
  const intersects = raycaster.intersectObject(targetModel, true);
  
  if (intersects.length > 0) {
    const point = intersects[0].point;
    // Smoothly move camera target to clicked point
    const startTarget = controls.target.clone();
    const endTarget = point.clone();
    let alpha = 0;
    
    function animateTarget() {
      alpha += 0.05;
      if (alpha > 1) alpha = 1;
      controls.target.lerpVectors(startTarget, endTarget, alpha);
      controls.update();
      if (alpha < 1) requestAnimationFrame(animateTarget);
    }
    animateTarget();
    
    console.log('[Camera] Focused on:', point.y.toFixed(2));
  }
});

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  const pr = renderer.getPixelRatio();
  if (fxaaPass) {
    fxaaPass.material.uniforms['resolution'].value.x = 1 / (innerWidth * pr);
    fxaaPass.material.uniforms['resolution'].value.y = 1 / (innerHeight * pr);
  }
});