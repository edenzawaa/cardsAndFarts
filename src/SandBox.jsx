import { onMount, onCleanup, createSignal, For, Show, createEffect } from "solid-js";
import * as THREE from 'three';

function SandBox() {
  let canvasContainer;
  let renderFrame;
  let animationFrameId = null;

  // --- MULTIPLAYER LOBBY STATE SIGNALS ---
  const [playerName, setPlayerName] = createSignal("");
  const [inputLobbyId, setInputLobbyId] = createSignal("");
  const [lobbyId, setLobbyId] = createSignal("");
  const [playerId, setPlayerId] = createSignal("");
  const [players, setPlayers] = createSignal([]);
  const [inLobby, setInLobby] = createSignal(false);
  const [gameStarted, setGameStarted] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal("");
  const [socketStatus, setSocketStatus] = createSignal("DISCONNECTED");

  // --- GAMEPLAY PHASE SIGNALS ---
  const [phase, setPhase] = createSignal("WAITING_FOR_CAPTION");
  const [activePlayerIdx, setActivePlayerIdx] = createSignal(0);
  const [currentCaption, setCurrentCaption] = createSignal("");
  const [captionRevealTimer, setCaptionRevealTimer] = createSignal(0);
  const [submissionTimer, setSubmissionTimer] = createSignal(0);
  const [revealIndex, setRevealIndex] = createSignal(-1);
  const [winnerId, setWinnerId] = createSignal("");
  const [hand, setHand] = createSignal([]);
  const [submissions, setSubmissions] = createSignal([]);
  const [captionOptions, setCaptionOptions] = createSignal([]);

  // Track the local hover index
  const [hoveredIndex, setHoveredIndex] = createSignal(null);

  // WebSocket reference
  let ws = null;
  let isCleanedUp = false;

  const isLocal = 
    window.location.hostname === 'localhost' || 
    window.location.hostname === '127.0.0.1' || 
    /^192\.168\./.test(window.location.hostname) || 
    /^10\./.test(window.location.hostname) || 
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(window.location.hostname) || 
    /\.local$/.test(window.location.hostname);

  const API_BASE = isLocal ? '' : 'https://cardsandfarts-api.onrender.com';
  const wsUrl = isLocal
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
    : 'wss://cardsandfarts-api.onrender.com/ws';

  const [isFullscreen, setIsFullscreen] = createSignal(false);

  const toggleFullscreen = () => {
    const docEl = document.documentElement;
    const request = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.msRequestFullscreen;
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (request) {
        request.call(docEl)
          .then(() => setIsFullscreen(true))
          .catch((err) => console.warn(err));
      }
    } else {
      if (exit) {
        exit.call(document)
          .then(() => setIsFullscreen(false))
          .catch((err) => console.warn(err));
      }
    }
  };

  // Gesture tracking variables
  let touchStartCard = null;
  let alreadyHoveredBeforeTouch = false;

  // Declared at component level so they can be accessed by SolidJS and WebGL
  let loadCardTexture;
  let cardMeshes = [];
  let cardOutlineMaterials = [];
  const cardsData = [];
  let textureLoader;
  const avatarsData = new Map();

  // 3D Caption Card declarations
  let captionCardMesh;
  let captionCardData = {
    currentX: 0, currentY: -6, currentZ: 0,
    currentRotX: 0, currentRotY: 0, currentRotZ: 0,
    targetX: 0, targetY: -6, targetZ: 0,
    targetRotX: 0, targetRotY: 0, targetRotZ: 0
  };
  let redrawCaptionCard;

  const maxCardMeshes = 8; // Support up to 8 players (7 submissions)

  // --- WEBSOCKET CONNECTION HELPER ---
  const connectWebSocket = (onOpenCallback) => {
    setErrorMsg("");
    setSocketStatus("CONNECTING");
    
    console.log(`[WebSocket] Connecting to ${wsUrl}...`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WebSocket] Connected to server');
      setSocketStatus("CONNECTED");
      if (onOpenCallback) onOpenCallback();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log(`[WebSocket] Received message:`, message);

        switch (message.type) {
          case 'JOIN_SUCCESS':
            setLobbyId(message.lobbyId);
            setPlayerId(message.playerId);
            setInLobby(true);
            setErrorMsg("");
            sessionStorage.setItem('cards_and_farts_lobby_id', message.lobbyId);
            sessionStorage.setItem('cards_and_farts_player_id', message.playerId);
            sessionStorage.setItem('cards_and_farts_player_name', playerName());
            break;

          case 'LOBBY_STATE':
            setPlayers(message.players);
            setGameStarted(message.gameStarted);
            setPhase(message.phase || "WAITING_FOR_CAPTION");
            setActivePlayerIdx(message.activePlayerIdx || 0);
            setCurrentCaption(message.currentCaption || "");
            setCaptionRevealTimer(message.captionRevealTimer || 0);
            setSubmissionTimer(message.submissionTimer || 0);
            setRevealIndex(message.revealIndex !== undefined ? message.revealIndex : -1);
            setWinnerId(message.winnerId || "");
            setHand(message.hand || []);
            setSubmissions(message.submissions || []);
            setCaptionOptions(message.captionOptions || []);
            break;

          case 'ERROR': {
            const msg = message.message;
            leaveLobby();
            setErrorMsg(msg);
            break;
          }
        }
      } catch (err) {
        console.error('[WebSocket] Error parsing message:', err);
      }
    };

    ws.onclose = () => {
      console.log('[WebSocket] Connection closed');
      setSocketStatus("DISCONNECTED");
      if (inLobby() && !isCleanedUp) {
        setErrorMsg("Disconnected from server. Attempting to reconnect...");
        
        // Attempt automatic reconnection after 2 seconds
        setTimeout(() => {
          if (inLobby() && !isCleanedUp) {
            const savedLobbyId = sessionStorage.getItem('cards_and_farts_lobby_id');
            const savedPlayerId = sessionStorage.getItem('cards_and_farts_player_id');
            if (savedLobbyId && savedPlayerId) {
              console.log(`[WebSocket] Attempting automatic reconnection...`);
              connectWebSocket(() => {
                ws.send(JSON.stringify({
                  type: 'RECONNECT',
                  lobbyId: savedLobbyId,
                  playerId: savedPlayerId
                }));
              });
            }
          }
        }, 2000);
      }
    };

    ws.onerror = (err) => {
      console.error('[WebSocket] Error:', err);
      setSocketStatus("DISCONNECTED");
      setErrorMsg("Failed to connect to backend server.");
    };
  };

  // --- SESSION RECOVERY ON MOUNT ---
  onMount(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("msfullscreenchange", handleFullscreenChange);

    onCleanup(() => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("msfullscreenchange", handleFullscreenChange);
    });

    const savedLobbyId = sessionStorage.getItem('cards_and_farts_lobby_id');
    const savedPlayerId = sessionStorage.getItem('cards_and_farts_player_id');
    const savedPlayerName = sessionStorage.getItem('cards_and_farts_player_name');

    if (savedPlayerName) {
      setPlayerName(savedPlayerName);
    }

    if (savedLobbyId && savedPlayerId) {
      console.log(`[Session] Found saved session for lobby ${savedLobbyId}, player ${savedPlayerId}. Reconnecting...`);
      connectWebSocket(() => {
        ws.send(JSON.stringify({
          type: 'RECONNECT',
          lobbyId: savedLobbyId,
          playerId: savedPlayerId
        }));
      });
    }
  });

  // --- LOBBY ACTIONS ---
  const handleCreateLobby = () => {
    connectWebSocket(() => {
      ws.send(JSON.stringify({
        type: 'CREATE_LOBBY',
        playerName: playerName() || 'Host'
      }));
    });
  };

  const handleJoinLobby = () => {
    const code = inputLobbyId().trim().toUpperCase();
    if (!code) {
      setErrorMsg("You need a room code!");
      return;
    }
    connectWebSocket(() => {
      ws.send(JSON.stringify({
        type: 'JOIN_LOBBY',
        lobbyId: code,
        playerName: playerName() || 'Guest'
      }));
    });
  };

  const handleStartGame = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'START_GAME' }));
    }
  };

  const handleDrawCaption = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'DRAW_CAPTION' }));
    }
  };

  const handleSelectCaption = (selectedCaption) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'SELECT_CAPTION',
        caption: selectedCaption
      }));
    }
  };

  const handleLocalVote = (rating) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'SUBMIT_VOTE',
        rating: rating
      }));
    }
  };

  const handleNextRound = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'NEXT_ROUND' }));
    }
  };

  const handlePlayAgain = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'PLAY_AGAIN' }));
    }
  };

  const leaveLobby = () => {
    if (ws) {
      ws.close();
      ws = null;
    }
    setInLobby(false);
    setGameStarted(false);
    setLobbyId("");
    setPlayerId("");
    setPlayers([]);
    setHand([]);
    setSubmissions([]);
    setPhase("WAITING_FOR_CAPTION");
    setErrorMsg("");
    resetCardOutlines();
    sessionStorage.removeItem('cards_and_farts_lobby_id');
    sessionStorage.removeItem('cards_and_farts_player_id');
  };

  // Helper to copy room code
  const copyRoomCode = () => {
    navigator.clipboard.writeText(lobbyId());
    const btn = document.getElementById("copy-btn");
    if (btn) {
      const originalText = btn.innerText;
      btn.innerText = "COPIED";
      setTimeout(() => {
        const resetBtn = document.getElementById("copy-btn");
        if (resetBtn) resetBtn.innerText = originalText;
      }, 1500);
    }
  };

  // Reset card outline colors to black
  const resetCardOutlines = () => {
    if (cardOutlineMaterials) {
      cardOutlineMaterials.forEach(mat => {
        if (mat) mat.color.setHex(0x000000);
      });
    }
    if (renderFrame) renderFrame();
  };

  // --- 3D CANVAS ON-MOUNT SETUP ---
  onMount(() => {
    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0c);

    // Camera (Anchored to the local player's eye level, looking inward at the campfire circle)
    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, -1.1, 1.7); // Anchored to local player's face at z = 1.7 (radius 2.2 - 0.5)
    camera.lookAt(0, -1.5, -0.5);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);  
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvasContainer.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
    dirLight.position.set(3, 5, 4); // Positioned to cast beautiful shadows across the island
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 15;
    dirLight.shadow.camera.left = -5;
    dirLight.shadow.camera.right = 5;
    dirLight.shadow.camera.top = 5;
    dirLight.shadow.camera.bottom = -5;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);

    // Playful cartoon sky background wall (placed far back to create a spacious horizon)
    const wallGeo = new THREE.PlaneGeometry(150, 80);
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0xb3e5fc, // Bright cartoon sky blue
      roughness: 0.9,
      metalness: 0.0
    });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(0, 10, -18);
    scene.add(wall);

    // Card geometry (Scaled down by 25% for a much cleaner framing)
    const cardGeometry = new THREE.BoxGeometry(1.2, 1.8, 0.05);
    const outlineThickness = 0.02;

    // Image plane geometry (Scaled down proportionally)
    const imageGeometry = new THREE.PlaneGeometry(1.0, 1.0);
    const imageOutlineGeometry = new THREE.PlaneGeometry(1.0 + outlineThickness * 2, 1.0 + outlineThickness * 2);

    const cardMaterials = [];
    const imageMaterials = [];

    // Shared black material for the image outlines
    const imageOutlineMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.DoubleSide
    });

    textureLoader = new THREE.TextureLoader();
    textureLoader.crossOrigin = 'anonymous';

    // --- CARD BACK TEXTURE & GEOMETRY GENERATOR ---
    const createCardBackTexture = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 384;
      const ctx = canvas.getContext('2d');
      
      // Vibrant purple background
      ctx.fillStyle = '#ab47bc'; 
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Thick black border
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 12;
      ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
      
      // Inner white dashed outline
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.setLineDash([8, 8]);
      ctx.strokeRect(16, 16, canvas.width - 32, canvas.height - 32);
      ctx.setLineDash([]); // Reset
      
      // Left eye white
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(95, 175, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      
      // Right eye white
      ctx.beginPath();
      ctx.arc(161, 175, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      
      // Pupils looking silly
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(105, 175, 12, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.beginPath();
      ctx.arc(148, 175, 12, 0, Math.PI * 2);
      ctx.fill();
      
      // Draw "FARTS" text at the bottom
      ctx.fillStyle = '#ffca28'; // Yellow-gold
      ctx.font = 'bold 26px "Fredoka", sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 5;
      ctx.strokeText('FARTS', 128, 275);
      ctx.fillText('FARTS', 128, 275);
      
      const tex = new THREE.CanvasTexture(canvas);
      return tex;
    };
    
    const cardBackTexture = createCardBackTexture();
    const backFaceGeometry = new THREE.PlaneGeometry(1.1, 1.7);
    const backFaceMat = new THREE.MeshBasicMaterial({
      map: cardBackTexture,
      side: THREE.DoubleSide
    });

    // Initialize 8 card meshes (Support fanning hands up to 5 and reveal rows up to 7)
    for (let i = 0; i < maxCardMeshes; i++) {
      cardsData.push({
        defaultX: 0, defaultY: 0, defaultZ: 0,
        defaultRotX: 0, defaultRotY: 0, defaultRotZ: 0,
        currentX: 0, currentY: 0, currentZ: 0,
        currentRotX: 0, currentRotY: 0, currentRotZ: 0,
        targetX: 0, targetY: 0, targetZ: 0,
        targetRotX: 0, targetRotY: 0, targetRotZ: 0,
        currentScale: 1.0, targetScale: 1.0,
        currentOpacity: 0,
        opacityTarget: 0
      });

      // Card Body Material (solid white)
      const cardMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.3,
        metalness: 0.0,
        side: THREE.DoubleSide
      });
      cardMaterials.push(cardMaterial);

      const cardMesh = new THREE.Mesh(cardGeometry, cardMaterial);
      cardMesh.position.set(0, -5, 0); // Hide initially below table
      scene.add(cardMesh);
      cardMeshes.push(cardMesh);

      // Card border (solid black outline)
      const outlineMaterial = new THREE.MeshBasicMaterial({
        color: 0x000000,
        side: THREE.BackSide
      });
      cardOutlineMaterials.push(outlineMaterial);

      const outlineMesh = new THREE.Mesh(cardGeometry, outlineMaterial);
      outlineMesh.scale.set(1 + outlineThickness, 1 + (outlineThickness * (2/3)), 1 + outlineThickness);
      cardMesh.add(outlineMesh);

      // --- 3D IMAGE PLANE SETUP ---
      const imageOutlineMesh = new THREE.Mesh(imageOutlineGeometry, imageOutlineMaterial);
      imageOutlineMesh.position.set(0, 0.22, 0.0255);
      cardMesh.add(imageOutlineMesh);

      const imageMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide
      });
      imageMaterials.push(imageMaterial);

      const imageMesh = new THREE.Mesh(imageGeometry, imageMaterial);
      imageMesh.name = "imagePlane";
      imageMesh.position.set(0, 0.22, 0.026);
      cardMesh.add(imageMesh);

      // --- 3D CARD BACK PLANE SETUP ---
      const backFaceMesh = new THREE.Mesh(backFaceGeometry, backFaceMat);
      backFaceMesh.position.set(0, 0, -0.026); // Tiny Z offset on the back side to prevent z-fighting
      backFaceMesh.rotation.y = Math.PI; // Face the opposite direction
      cardMesh.add(backFaceMesh);
    }

    // --- 3D CAPTION CARD SETUP ---
    const captionCanvas = document.createElement('canvas');
    captionCanvas.width = 512;
    captionCanvas.height = 768;
    const captionCtx = captionCanvas.getContext('2d');
    const captionTexture = new THREE.CanvasTexture(captionCanvas);

    const captionCardGeo = new THREE.BoxGeometry(1.4, 2.1, 0.05);
    const captionCardMat = new THREE.MeshStandardMaterial({
      color: 0x1e1e24, // Dark charcoal
      roughness: 0.4,
      metalness: 0.1,
      side: THREE.DoubleSide
    });
    captionCardMesh = new THREE.Mesh(captionCardGeo, captionCardMat);
    captionCardMesh.scale.set(0.65, 0.65, 0.65); // Scaled down to prevent ground clipping
    captionCardMesh.position.set(0, -6, 0); // Start deep below
    scene.add(captionCardMesh);

    // Thick black border for the caption card
    const captionOutlineMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.BackSide
    });
    const captionOutlineMesh = new THREE.Mesh(captionCardGeo, captionOutlineMat);
    captionOutlineMesh.scale.set(1 + outlineThickness, 1 + (outlineThickness * (2/3)), 1 + outlineThickness);
    captionCardMesh.add(captionOutlineMesh);

    // Face plane for the caption text
    const captionFaceGeo = new THREE.PlaneGeometry(1.3, 2.0);
    const captionFaceMat = new THREE.MeshBasicMaterial({
      map: captionTexture,
      transparent: true,
      side: THREE.DoubleSide
    });
    const captionFaceMesh = new THREE.Mesh(captionFaceGeo, captionFaceMat);
    captionFaceMesh.position.set(0, 0, 0.026);
    captionCardMesh.add(captionFaceMesh);

    // Redraw function to update the caption text on the card face
    redrawCaptionCard = (text) => {
      if (!captionCtx) return;

      // Fill background (dark charcoal)
      captionCtx.fillStyle = '#1e1e24';
      captionCtx.fillRect(0, 0, 512, 768);

      // Thick yellow comic border
      captionCtx.strokeStyle = '#ffca28';
      captionCtx.lineWidth = 18;
      captionCtx.strokeRect(14, 14, 512 - 28, 768 - 28);

      // Inner thin black detail line
      captionCtx.strokeStyle = '#000000';
      captionCtx.lineWidth = 4;
      captionCtx.strokeRect(24, 24, 512 - 48, 768 - 48);

      // Draw "ROUND CAPTION" header at the top
      captionCtx.fillStyle = '#ff4081'; // Hot pink
      captionCtx.font = 'bold 28px "Outfit", "Fredoka", sans-serif';
      captionCtx.textAlign = 'center';
      captionCtx.fillText('ROUND CAPTION', 256, 100);

      // Draw the wrapped caption text in the center
      captionCtx.fillStyle = '#ffffff';
      captionCtx.font = 'bold 34px "Outfit", "Fredoka", sans-serif';
      captionCtx.textAlign = 'center';
      captionCtx.textBaseline = 'middle';

      const words = (text || "Waiting for caption...").split(' ');
      let line = '';
      let lines = [];
      const maxWidth = 400;

      for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + ' ';
        const metrics = captionCtx.measureText(testLine);
        if (metrics.width > maxWidth && n > 0) {
          lines.push(line);
          line = words[n] + ' ';
        } else {
          line = testLine;
        }
      }
      lines.push(line);

      const lineHeight = 50;
      const startY = 384 - ((lines.length - 1) * lineHeight) / 2;

      lines.forEach((l, idx) => {
        captionCtx.fillText(l.trim(), 256, startY + idx * lineHeight);
      });

      // No cute silly face at the bottom (removed emoji)

      captionTexture.needsUpdate = true;
      if (renderFrame) renderFrame();
    };

    // --- 3D LOW-POLY FLOATING ISLAND ENVIRONMENT ---
    const islandGroup = new THREE.Group();
    islandGroup.position.set(0, -1.9, -0.5); // Centered below the cards
    scene.add(islandGroup);

    // 1. The Sand Island (tapered low-poly cylinder)
    const islandGeo = new THREE.CylinderGeometry(3.6, 2.8, 0.8, 14); // 14 segments = low-poly look!
    const islandMat = new THREE.MeshStandardMaterial({
      color: 0xe2c58a, // Sand yellow
      roughness: 0.9,
      metalness: 0.0,
      flatShading: true // Faceted low-poly look
    });
    const island = new THREE.Mesh(islandGeo, islandMat);
    island.position.y = -0.4; // Offset so top surface is at y = -1.9 relative to scene
    island.receiveShadow = true; // Receive tree shadows
    islandGroup.add(island);

    // 2. The Cartoon Ocean (large blue cylinder below)
    const oceanGeo = new THREE.CylinderGeometry(50, 50, 0.2, 16);
    const oceanMat = new THREE.MeshStandardMaterial({
      color: 0x00b0ff, // Vibrant cyan-blue water
      roughness: 0.15,
      metalness: 0.1,
      flatShading: true
    });
    const ocean = new THREE.Mesh(oceanGeo, oceanMat);
    ocean.position.y = -0.8; // Positioned slightly below the island sand
    islandGroup.add(ocean);

    // 3. Stylized Low-Poly Palm Tree (Placed in the background to prevent clipping)
    const treeGroup = new THREE.Group();
    treeGroup.position.set(-2.5, 0.0, -1.6); // Positioned far behind the cards
    treeGroup.scale.set(1.25, 1.25, 1.25);  // Scaled up so it stands tall in the background
    islandGroup.add(treeGroup);

    // Trunk: 5 stacked segments curved slightly to the left (away from cards)
    const trunkColor = 0x8d6e63; // Warm brown
    const trunkMat = new THREE.MeshStandardMaterial({
      color: trunkColor,
      roughness: 0.8,
      flatShading: true
    });

    const trunkSegments = 5;
    let currentY = 0.0;
    let currentX = 0.0;
    for (let j = 0; j < trunkSegments; j++) {
      const segHeight = 0.42; // Taller trunk segments
      const segRadTop = 0.12 - j * 0.012;
      const segRadBot = 0.15 - j * 0.012;
      const segGeo = new THREE.CylinderGeometry(segRadTop, segRadBot, segHeight, 8);
      const segment = new THREE.Mesh(segGeo, trunkMat);
      
      // Curve trunk to the left (away from the card fan)
      segment.position.set(currentX, currentY + segHeight/2, 0);
      const tilt = 0.08 + j * 0.035;
      segment.rotation.z = tilt; // Positive Z tilt tilts to the left
      
      segment.castShadow = true;
      segment.receiveShadow = true;
      treeGroup.add(segment);
      
      currentY += segHeight * Math.cos(tilt);
      currentX -= segHeight * Math.sin(tilt); // Shift left
    }

    // Leaves: fanned out at the top of the trunk
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0x2e7d32, // Vibrant green
      roughness: 0.6,
      flatShading: true
    });

    const leafCount = 6;
    const leafGroup = new THREE.Group();
    leafGroup.position.set(currentX, currentY, 0); // At the top of the trunk
    treeGroup.add(leafGroup);

    for (let j = 0; j < leafCount; j++) {
      const angle = (j / leafCount) * Math.PI * 2;
      const leafGeo = new THREE.BoxGeometry(1.2, 0.04, 0.28);
      leafGeo.translate(0.6, 0, 0); // Move pivot to stem base
      
      const leaf = new THREE.Mesh(leafGeo, leafMat);
      leaf.rotation.y = angle;
      leaf.rotation.z = -0.22; // Tilt down
      leaf.rotation.x = (Math.random() - 0.5) * 0.1;
      leaf.castShadow = true;
      leaf.receiveShadow = true;

      leafGroup.add(leaf);
    }

    // Coconuts under the leaves
    const cocoMat = new THREE.MeshStandardMaterial({
      color: 0x5d4037, // Brown coconut
      roughness: 0.9,
      flatShading: true
    });
    const cocoGeo = new THREE.DodecahedronGeometry(0.09, 0); // Low poly!
    
    const coco1 = new THREE.Mesh(cocoGeo, cocoMat);
    coco1.position.set(currentX - 0.08, currentY - 0.05, 0.08);
    coco1.castShadow = true;
    treeGroup.add(coco1);
    
    const coco2 = new THREE.Mesh(cocoGeo, cocoMat);
    coco2.position.set(currentX + 0.08, currentY - 0.06, -0.04);
    coco2.castShadow = true;
    treeGroup.add(coco2);

    const coco3 = new THREE.Mesh(cocoGeo, cocoMat);
    coco3.position.set(currentX, currentY - 0.08, 0.1);
    coco3.castShadow = true;
    treeGroup.add(coco3);

    // 4. Silly Little Low-Poly Rocks on the Sand (Positioned in the background of the beach)
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x90a4ae, // Grey rock
      roughness: 0.9,
      flatShading: true
    });

    // Right rock cluster (3 rocks nested together)
    const rock1Geo = new THREE.DodecahedronGeometry(0.28, 0);
    const rock1 = new THREE.Mesh(rock1Geo, rockMat);
    rock1.position.set(2.8, 0.05, -0.2); // Resting on sand
    rock1.rotation.set(Math.random(), Math.random(), Math.random());
    islandGroup.add(rock1);

    const rock2Geo = new THREE.DodecahedronGeometry(0.18, 0);
    const rock2 = new THREE.Mesh(rock2Geo, rockMat);
    rock2.position.set(3.1, 0.02, -0.6); // Resting on sand
    rock2.rotation.set(Math.random(), Math.random(), Math.random());
    islandGroup.add(rock2);

    const rock3Geo = new THREE.DodecahedronGeometry(0.12, 0);
    const rock3 = new THREE.Mesh(rock3Geo, rockMat);
    rock3.position.set(2.6, 0.01, -0.5); // Resting on sand next to rock1
    rock3.rotation.set(Math.random(), Math.random(), Math.random());
    islandGroup.add(rock3);

    // Left rock cluster near palm tree base (2 rocks nested together)
    const leftRock1 = new THREE.Mesh(rock2Geo, rockMat);
    leftRock1.position.set(-2.6, 0.02, -1.0);
    leftRock1.rotation.set(Math.random(), Math.random(), Math.random());
    islandGroup.add(leftRock1);

    const leftRock2 = new THREE.Mesh(rock3Geo, rockMat);
    leftRock2.position.set(-2.8, 0.01, -1.2);
    leftRock2.rotation.set(Math.random(), Math.random(), Math.random());
    islandGroup.add(leftRock2);

    // Starfish on the sand (Resting on surface at Y = 0.02/0.015 instead of buried at Y = -0.38)
    const starfishMat = new THREE.MeshStandardMaterial({
      color: 0xff4081, // Hot pink starfish!
      roughness: 0.8,
      flatShading: true
    });
    const starfishGeo = new THREE.ConeGeometry(0.12, 0.04, 5);
    const starfish = new THREE.Mesh(starfishGeo, starfishMat);
    starfish.position.set(1.4, 0.02, 0.8); // Rest on sand near the front right
    starfish.rotation.set(Math.PI / 2 + 0.1, 0, Math.random());
    islandGroup.add(starfish);

    const starfish2Mat = new THREE.MeshStandardMaterial({
      color: 0xff7043, // Orange starfish
      roughness: 0.8,
      flatShading: true
    });
    const starfish2Geo = new THREE.ConeGeometry(0.08, 0.03, 5);
    const starfish2 = new THREE.Mesh(starfish2Geo, starfish2Mat);
    starfish2.position.set(-1.8, 0.015, -0.8); // Rest on sand on the left beach
    starfish2.rotation.set(Math.PI / 2 + 0.05, 0, Math.random());
    islandGroup.add(starfish2);
    
    // Shells on the sand (Resting on surface at Y = 0.03/0.02 instead of buried at Y = -0.39)
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0xffab40, // Orange shell
      roughness: 0.6,
      flatShading: true
    });
    const shellGeo = new THREE.SphereGeometry(0.07, 6, 6);
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.position.set(-1.2, 0.03, 1.2); // Rest on sand near the front left
    shell.scale.set(1.4, 0.6, 0.9);
    shell.rotation.set(0.2, 0.5, 0.8);
    islandGroup.add(shell);

    const clamMat = new THREE.MeshStandardMaterial({
      color: 0xfaf6eb, // Warm white clam shell
      roughness: 0.7,
      flatShading: true
    });
    const clamGeo = new THREE.SphereGeometry(0.05, 5, 5);
    const clam = new THREE.Mesh(clamGeo, clamMat);
    clam.position.set(2.4, 0.02, 0.2); // Rest on sand near the right rocks
    clam.scale.set(1.3, 0.3, 1.0);
    clam.rotation.set(0.1, -0.4, 0.5);
    islandGroup.add(clam);

    // --- STYLIZED LOW-POLY CARTOON CRAB ---
    const createCartoonCrab = () => {
      const crabGroup = new THREE.Group();
      
      const crabRedMat = new THREE.MeshStandardMaterial({
        color: 0xff4e2a, // Cute cartoon red-orange
        roughness: 0.5,
        flatShading: true
      });
      
      const crabBlackMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
      const crabWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

      // 1. Crab Body: Squashed sphere
      const bodyGeo = new THREE.SphereGeometry(0.08, 12, 12);
      bodyGeo.scale(1.3, 0.75, 1.0);
      const bodyMesh = new THREE.Mesh(bodyGeo, crabRedMat);
      bodyMesh.position.y = 0.04; // Raised slightly so it sits on legs
      bodyMesh.castShadow = true;
      crabGroup.add(bodyMesh);

      // 2. Eye Stalks and Googly Eyes
      const stalkGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.05, 6);
      const eyeGeo = new THREE.SphereGeometry(0.02, 8, 8);
      const pupilGeo = new THREE.SphereGeometry(0.008, 6, 6);

      // Left Eye
      const leftStalk = new THREE.Mesh(stalkGeo, crabRedMat);
      leftStalk.position.set(-0.03, 0.07, 0.04);
      leftStalk.rotation.z = -0.15; // Angled slightly outward
      crabGroup.add(leftStalk);

      const leftEyeBall = new THREE.Mesh(eyeGeo, crabWhiteMat);
      leftEyeBall.position.set(0, 0.025, 0);
      leftStalk.add(leftEyeBall);

      const leftPupil = new THREE.Mesh(pupilGeo, crabBlackMat);
      leftPupil.position.set(0, 0, 0.016); // Looking forward
      leftEyeBall.add(leftPupil);

      // Right Eye
      const rightStalk = new THREE.Mesh(stalkGeo, crabRedMat);
      rightStalk.position.set(0.03, 0.07, 0.04);
      rightStalk.rotation.z = 0.15; // Angled slightly outward
      crabGroup.add(rightStalk);

      const rightEyeBall = new THREE.Mesh(eyeGeo, crabWhiteMat);
      rightEyeBall.position.set(0, 0.025, 0);
      rightStalk.add(rightEyeBall);

      const rightPupil = new THREE.Mesh(pupilGeo, crabBlackMat);
      rightPupil.position.set(0, 0, 0.016); // Looking forward
      rightEyeBall.add(rightPupil);

      // 3. Big Claws (Pincers) at the front
      const armGeo = new THREE.BoxGeometry(0.015, 0.015, 0.06);
      const clawGeo = new THREE.SphereGeometry(0.032, 8, 8);
      clawGeo.scale(1.2, 1.0, 1.4); // Elongated pincer shape

      // Left Claw
      const leftArm = new THREE.Mesh(armGeo, crabRedMat);
      leftArm.position.set(-0.07, 0.03, 0.05);
      leftArm.rotation.set(0.1, -0.6, -0.2); // Rotated forward-left
      crabGroup.add(leftArm);

      const leftClaw = new THREE.Mesh(clawGeo, crabRedMat);
      leftClaw.position.set(0, 0, 0.035);
      leftClaw.rotation.y = -0.2;
      leftArm.add(leftClaw);

      // Right Claw
      const rightArm = new THREE.Mesh(armGeo, crabRedMat);
      rightArm.position.set(0.07, 0.03, 0.05);
      rightArm.rotation.set(0.1, 0.6, 0.2); // Rotated forward-right
      crabGroup.add(rightArm);

      const rightClaw = new THREE.Mesh(clawGeo, crabRedMat);
      rightClaw.position.set(0, 0, 0.035);
      rightClaw.rotation.y = 0.2;
      rightArm.add(rightClaw);

      // 4. Little Bent Legs (3 on each side)
      const legGeo = new THREE.BoxGeometry(0.01, 0.01, 0.07);

      for (let k = 0; k < 3; k++) {
        const sideAngle = (k - 1) * 0.35; // Fanned out angles

        // Left Legs
        const leftLeg = new THREE.Mesh(legGeo, crabRedMat);
        leftLeg.position.set(-0.06, 0.02, -0.02 + (k - 1) * 0.03);
        leftLeg.rotation.set(0.2, -Math.PI / 2 + sideAngle, -0.6); // Bent down to touch sand
        leftLeg.castShadow = true;
        crabGroup.add(leftLeg);

        // Right Legs
        const rightLeg = new THREE.Mesh(legGeo, crabRedMat);
        rightLeg.position.set(0.06, 0.02, -0.02 + (k - 1) * 0.03);
        rightLeg.rotation.set(0.2, Math.PI / 2 - sideAngle, 0.6); // Bent down to touch sand
        rightLeg.castShadow = true;
        crabGroup.add(rightLeg);
      }

      return crabGroup;
    };

    const crab = createCartoonCrab();
    crab.position.set(-1.0, 0.0, 0.4); // Positioned on the center-left portion of the beach
    crab.rotation.y = Math.PI / 3; // Angled slightly towards the center campfire
    islandGroup.add(crab);

    // --- STYLIZED LOW-POLY FLOATING CLOUDS ---
    const clouds = [];
    const createCartoonCloud = () => {
      const cloud = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.9,
        metalness: 0.0,
        flatShading: true
      });
      const geo = new THREE.DodecahedronGeometry(0.35, 0);
      
      const m1 = new THREE.Mesh(geo, mat);
      m1.position.set(0, 0, 0);
      m1.scale.set(1.5, 0.9, 1.2);
      cloud.add(m1);
      
      const m2 = new THREE.Mesh(geo, mat);
      m2.position.set(-0.35, -0.05, 0.05);
      m2.scale.set(1.0, 0.75, 0.9);
      cloud.add(m2);
      
      const m3 = new THREE.Mesh(geo, mat);
      m3.position.set(0.35, -0.05, -0.05);
      m3.scale.set(1.1, 0.8, 1.0);
      cloud.add(m3);

      const m4 = new THREE.Mesh(geo, mat);
      m4.position.set(0, 0.2, -0.05);
      m4.scale.set(0.9, 0.7, 0.95);
      cloud.add(m4);
      
      return cloud;
    };

    const cloudCoords = [
      { x: -15, y: 1.2, z: -12.0 },
      { x: -2, y: 2.2, z: -14.0 },
      { x: 12, y: 1.0, z: -13.0 }
    ];

    cloudCoords.forEach(coords => {
      const cloud = createCartoonCloud();
      cloud.scale.set(3.5, 3.5, 3.5); // Scaled up in the far distance
      cloud.position.set(coords.x, coords.y, coords.z);
      scene.add(cloud);
      clouds.push(cloud);
    });

    // --- STYLIZED LOW-POLY SUN ---
    const sunGeo = new THREE.DodecahedronGeometry(1.8, 0); // Large distant sun
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xffeb3b, // Glowing yellow
    });
    const sunMesh = new THREE.Mesh(sunGeo, sunMat);
    sunMesh.position.set(8.0, 3.2, -17.5); // Far right in the sky
    scene.add(sunMesh);

    renderFrame = () => {
      renderer.render(scene, camera);
    };

    // Initial render
    renderFrame();

    // --- TEXTURE LOADER WITH FADE IN/OUT ---
    loadCardTexture = (index, url) => {
      const mesh = cardMeshes[index];
      if (!mesh) return;

      // First fade out the current image
      cardsData[index].opacityTarget = 0;
      if (!animationFrameId) animate();

      // Wait for fade-out, then load new image
      setTimeout(() => {
        textureLoader.load(
          url,
          (texture) => {
            const plane = mesh.getObjectByName("imagePlane");
            if (plane) {
              if (plane.material.map) {
                plane.material.map.dispose();
              }
              plane.material.map = texture;
              plane.material.needsUpdate = true;

              // Fade in the new image
              cardsData[index].opacityTarget = 1;
              if (!animationFrameId) animate();
            }
          },
          undefined,
          (err) => {
            console.error(`[WebGL] Failed to load texture for card ${index}:`, err);
          }
        );
      }, 250);
    };

    // --- LERP ANIMATION LOOP (ON-DEMAND) ---
    const animate = () => {
      let isMoving = false;
      const lerpFactor = 0.16;
      const opacityLerpFactor = 0.14;

      // Lerp player hand and submission cards
      cardsData.forEach((card, i) => {
        const mesh = cardMeshes[i];
        if (!mesh || !mesh.visible) return; // Skip invisible meshes to optimize

        // Lerp positions
        card.currentX += (card.targetX - card.currentX) * lerpFactor;
        card.currentY += (card.targetY - card.currentY) * lerpFactor;
        card.currentZ += (card.targetZ - card.currentZ) * lerpFactor;

        // Lerp rotations
        card.currentRotX += (card.targetRotX - card.currentRotX) * lerpFactor;
        card.currentRotY += (card.targetRotY - card.currentRotY) * lerpFactor;
        card.currentRotZ += (card.targetRotZ - card.currentRotZ) * lerpFactor;

        // Lerp scale
        if (card.currentScale === undefined) card.currentScale = 1.0;
        if (card.targetScale === undefined) card.targetScale = 1.0;
        card.currentScale += (card.targetScale - card.currentScale) * lerpFactor;

        // Snap individually if extremely close to target to avoid infinite precision lerp
        const posError = Math.abs(card.targetX - card.currentX) + Math.abs(card.targetY - card.currentY) + Math.abs(card.targetZ - card.currentZ);
        const rotError = Math.abs(card.targetRotX - card.currentRotX) + Math.abs(card.targetRotY - card.currentRotY) + Math.abs(card.targetRotZ - card.currentRotZ);
        const scaleError = Math.abs(card.targetScale - card.currentScale);

        if (posError < 0.0015 && rotError < 0.0015 && scaleError < 0.0015) {
          card.currentX = card.targetX;
          card.currentY = card.targetY;
          card.currentZ = card.targetZ;
          card.currentRotX = card.targetRotX;
          card.currentRotY = card.targetRotY;
          card.currentRotZ = card.targetRotZ;
          card.currentScale = card.targetScale;
        }

        mesh.position.set(card.currentX, card.currentY, card.currentZ);
        mesh.rotation.set(card.currentRotX, card.currentRotY, card.currentRotZ);
        mesh.scale.set(card.currentScale, card.currentScale, card.currentScale);

        // Lerp opacity
        const plane = mesh.getObjectByName("imagePlane");
        if (plane) {
          card.currentOpacity += (card.opacityTarget - card.currentOpacity) * opacityLerpFactor;
          
          if (Math.abs(card.opacityTarget - card.currentOpacity) < 0.01) {
            card.currentOpacity = card.opacityTarget;
          }
          
          plane.material.opacity = card.currentOpacity;
          
          if (Math.abs(card.opacityTarget - card.currentOpacity) > 0.01) {
            isMoving = true;
          }
        }

        if (posError > 0.002 || rotError > 0.002 || scaleError > 0.002) {
          isMoving = true;
        }
      });

      // Lerp Caption Card
      if (captionCardMesh) {
        captionCardData.currentX += (captionCardData.targetX - captionCardData.currentX) * lerpFactor;
        captionCardData.currentY += (captionCardData.targetY - captionCardData.currentY) * lerpFactor;
        captionCardData.currentZ += (captionCardData.targetZ - captionCardData.currentZ) * lerpFactor;

        captionCardData.currentRotX += (captionCardData.targetRotX - captionCardData.currentRotX) * lerpFactor;
        captionCardData.currentRotY += (captionCardData.targetRotY - captionCardData.currentRotY) * lerpFactor;
        captionCardData.currentRotZ += (captionCardData.targetRotZ - captionCardData.currentRotZ) * lerpFactor;

        captionCardMesh.position.set(captionCardData.currentX, captionCardData.currentY, captionCardData.currentZ);
        captionCardMesh.rotation.set(captionCardData.currentRotX, captionCardData.currentRotY, captionCardData.currentRotZ);

        const currentPhase = phase();
        if (currentPhase === 'CAPTION_REVEAL') {
          // Playful, dramatic wiggling and bobbing closer to camera
          captionCardMesh.position.y = captionCardData.currentY + Math.sin(Date.now() * 0.005) * 0.08;
          captionCardMesh.rotation.z = captionCardData.currentRotZ + Math.sin(Date.now() * 0.01) * 0.05;
          isMoving = true; // Keep wiggling active!
        } else if (currentPhase === 'SUBMITTING_CARDS' || currentPhase === 'REVEALING_CARDS' || currentPhase === 'ROUND_RESULTS') {
          // Gentle bobbing high in the sky in the background
          captionCardMesh.position.y = captionCardData.currentY + Math.sin(Date.now() * 0.002) * 0.04;
          captionCardMesh.rotation.z = captionCardData.currentRotZ + Math.sin(Date.now() * 0.001) * 0.02;
          isMoving = true; // Keep bobbing active!
        }

        const capPosErr = Math.abs(captionCardData.targetY - captionCardData.currentY) + Math.abs(captionCardData.targetZ - captionCardData.currentZ);
        if (capPosErr > 0.002) {
          isMoving = true;
        }
      }

      // Lerp other player avatars
      avatarsData.forEach((info) => {
        const avatarLerp = 0.12;
        info.currentX += (info.targetX - info.currentX) * avatarLerp;
        info.currentY += (info.targetY - info.currentY) * avatarLerp;
        info.currentZ += (info.targetZ - info.currentZ) * avatarLerp;
        
        info.currentRotX += (info.targetRotX - info.currentRotX) * avatarLerp;
        info.currentRotY += (info.targetRotY - info.currentRotY) * avatarLerp;

        info.group.position.set(info.currentX, info.currentY, info.currentZ);
        info.group.rotation.set(info.currentRotX, info.currentRotY, 0);

        // Bobbing and wiggling when hovering
        if (info.targetRotX > 0.1) {
          info.group.rotation.z = Math.sin(Date.now() * 0.015) * 0.12;
          info.group.position.y += Math.sin(Date.now() * 0.01) * 0.04;
        } else {
          info.group.rotation.z = 0;
        }

        // Smooth eye tracking: slide pupils to look at the card being hovered
        const leftPupil = info.group.getObjectByName("leftPupil");
        const rightPupil = info.group.getObjectByName("rightPupil");
        if (leftPupil && rightPupil) {
          let targetPupilX_left = 0.01;
          let targetPupilX_right = -0.01;
          let targetPupilY = 0;

          if (info.hoveredCard !== null && info.hoveredCard !== undefined && info.hoveredCard >= 0) {
            const size = info.handSize || 0;
            const hovered = info.hoveredCard;
            // Calculate t from -1 (leftmost card) to 1 (rightmost card)
            const t = size > 1 ? (hovered - (size - 1) / 2) / ((size - 1) / 2) : 0;
            
            // Shift pupils in the direction of the hovered card (t)
            // Left pupil default is 0.01, right pupil default is -0.01
            targetPupilX_left = 0.01 + t * 0.012;
            targetPupilX_right = -0.01 + t * 0.012;
            // The hand cards are below the eyes, so look down
            targetPupilY = -0.015;
          }

          // Smoothly lerp pupils for a premium, organic look
          leftPupil.position.x += (targetPupilX_left - leftPupil.position.x) * 0.18;
          leftPupil.position.y += (targetPupilY - leftPupil.position.y) * 0.18;
          rightPupil.position.x += (targetPupilX_right - rightPupil.position.x) * 0.18;
          rightPupil.position.y += (targetPupilY - rightPupil.position.y) * 0.18;
        }

        // Lerp opponent's hand cards inside their avatar
        if (info.opponentCardMeshes && info.opponentCardData) {
          info.opponentCardMeshes.forEach((mesh, k) => {
            if (!mesh || !mesh.visible) return;
            const cardData = info.opponentCardData[k];
            
            cardData.currentX += (cardData.targetX - cardData.currentX) * 0.16;
            cardData.currentY += (cardData.targetY - cardData.currentY) * 0.16;
            cardData.currentZ += (cardData.targetZ - cardData.currentZ) * 0.16;

            cardData.currentRotX += (cardData.targetRotX - cardData.currentRotX) * 0.16;
            cardData.currentRotY += (cardData.targetRotY - cardData.currentRotY) * 0.16;
            cardData.currentRotZ += (cardData.targetRotZ - cardData.currentRotZ) * 0.16;

            mesh.position.set(cardData.currentX, cardData.currentY, cardData.currentZ);
            mesh.rotation.set(cardData.currentRotX, cardData.currentRotY, cardData.currentRotZ);
          });
        }

        // Keep animating if the avatar hasn't reached its target
        const posErr = Math.abs(info.targetX - info.currentX) + Math.abs(info.targetY - info.currentY);
        if (posErr > 0.005) {
          isMoving = true;
        }
      });

      // Gently bob and rotate the cartoon ocean water
      if (ocean) {
        ocean.position.y = -0.8 + Math.sin(Date.now() * 0.001) * 0.02;
        ocean.rotation.y = Date.now() * 0.00005;
      }

      // Slowly drift and wrap clouds
      if (clouds && clouds.length > 0) {
        clouds.forEach(cloud => {
          cloud.position.x += 0.004; // Slightly faster drift for the wider sky
          if (cloud.position.x > 22) {
            cloud.position.x = -22;
          }
        });
      }

      // Always keep the animation loop running to animate waves and drifting clouds
      isMoving = true;

      renderFrame();

      if (isMoving) {
        animationFrameId = requestAnimationFrame(animate);
      } else {
        // Snap to targets when motion stops
        cardsData.forEach((card, i) => {
          const mesh = cardMeshes[i];
          if (!mesh || !mesh.visible) return;
          mesh.position.set(card.targetX, card.targetY, card.targetZ);
          mesh.rotation.set(card.targetRotX, card.targetRotY, card.targetRotZ);
          
          const plane = mesh.getObjectByName("imagePlane");
          if (plane) {
            plane.material.opacity = card.opacityTarget;
            card.currentOpacity = card.opacityTarget;
          }
        });

        if (captionCardMesh) {
          captionCardMesh.position.set(captionCardData.targetX, captionCardData.targetY, captionCardData.targetZ);
          captionCardMesh.rotation.set(captionCardData.targetRotX, captionCardData.targetRotY, captionCardData.targetRotZ);
          captionCardData.currentX = captionCardData.targetX;
          captionCardData.currentY = captionCardData.targetY;
          captionCardData.currentZ = captionCardData.targetZ;
          captionCardData.currentRotX = captionCardData.targetRotX;
          captionCardData.currentRotY = captionCardData.targetRotY;
          captionCardData.currentRotZ = captionCardData.targetRotZ;
        }

        avatarsData.forEach((info) => {
          info.group.position.set(info.targetX, info.targetY, info.targetZ);
          info.group.rotation.set(info.targetRotX, info.targetRotY, 0);
          info.currentX = info.targetX;
          info.currentY = info.targetY;
          info.currentZ = info.targetZ;
          info.currentRotX = info.targetRotX;
          info.currentRotY = info.targetRotY;

          // Snap opponent hand cards
          if (info.opponentCardMeshes && info.opponentCardData) {
            info.opponentCardMeshes.forEach((mesh, k) => {
              if (!mesh || !mesh.visible) return;
              const cardData = info.opponentCardData[k];
              cardData.currentX = cardData.targetX;
              cardData.currentY = cardData.targetY;
              cardData.currentZ = cardData.targetZ;
              cardData.currentRotX = cardData.targetRotX;
              cardData.currentRotY = cardData.targetRotY;
              cardData.currentRotZ = cardData.targetRotZ;
              mesh.position.set(cardData.targetX, cardData.targetY, cardData.targetZ);
              mesh.rotation.set(cardData.targetRotX, cardData.targetRotY, cardData.targetRotZ);
            });
          }
        });

        renderFrame();
        animationFrameId = null;
      }
    };

    // Helper to calculate circular coordinates for players and played cards
    const getPlayerCircleCoords = (playerIdOrIndex, type = 'avatar') => {
      const lobbyPlayers = players();
      const count = lobbyPlayers.length || 1;
      
      let index = -1;
      if (typeof playerIdOrIndex === 'string') {
        index = lobbyPlayers.findIndex(p => p.id === playerIdOrIndex);
      } else {
        index = playerIdOrIndex;
      }
      
      if (index === -1) {
        return { x: 0, y: type === 'card' ? -1.65 : -1.47, z: -0.9, rotY: 0 };
      }
      
      // Orient the circle relative to the local player always at the front (Math.PI / 2)
      const localIdx = lobbyPlayers.findIndex(p => p.id === playerId());
      const relIdx = localIdx !== -1 ? (index - localIdx + count) % count : index;
      
      const theta = Math.PI / 2 + (relIdx * 2 * Math.PI / count);
      
      // Avatar stands at outer radius, played card is positioned in front of them at inner radius
      const radius = type === 'card' ? 1.0 : 2.2; // Compact campfire circle to see opponents clearly!
      
      const x = radius * Math.cos(theta);
      const z = -0.5 + radius * Math.sin(theta);
      const y = type === 'card' ? -1.65 : -1.47; // Cards rest on the island surface
      const rotY = -theta - Math.PI / 2; // Face inward towards the island center
      
      return { x, y, z, rotY };
    };

    // --- DYNAMIC PHASE-BASED POSITION TRIGGER ---
    const updateTargets = (snapImmediately = false) => {
      const currentPhase = phase();
      const currentHand = hand();
      const currentSubmissions = submissions();
      const hovered = hoveredIndex();
      
      const inRevealPhase = currentPhase === 'REVEALING_CARDS' || currentPhase === 'ROUND_RESULTS';

      if (inRevealPhase) {
        // --- REVEAL PHASE: LAYOUT SUBMITTED CARDS IN FRONT OF THEIR CORRESPONDING PLAYERS ---
        const numSubmissions = currentSubmissions.length;
        
        for (let i = 0; i < maxCardMeshes; i++) {
          const card = cardsData[i];
          const mesh = cardMeshes[i];
          if (!mesh) continue;

          if (i < numSubmissions) {
            mesh.visible = true;
            const sub = currentSubmissions[i];
            const coords = getPlayerCircleCoords(sub.playerId, 'card');
            
            if (currentPhase === 'REVEALING_CARDS' && i === revealIndex()) {
              // --- ACTIVE VOTING CARD: FLOAT UP FOR CLOSE-UP REVEAL ---
              card.targetX = 0;
              card.targetY = -1.15; // Raised to eye level
              card.targetZ = -0.3; // Pulled closer (distance 2.0 units from camera at z = 1.7)
              card.targetScale = 0.5; // Large, clear, and perfectly readable
              card.targetRotX = -0.15; // Tilted to face the camera
              card.targetRotY = 0; // Face up!
              card.targetRotZ = 0;
            } else {
              // --- OTHER CARDS: REST ON THE TABLE ---
              card.targetX = coords.x;
              card.targetY = coords.y;
              card.targetZ = coords.z;
              card.targetScale = 0.24; // Small tabletop card scale
              card.targetRotX = -0.2; // Lying flat/tilted on table
              
              if (currentPhase === 'ROUND_RESULTS' || i < revealIndex()) {
                card.targetRotY = 0; // Face up (revealed/voted)
              } else {
                card.targetRotY = Math.PI; // Face down (hidden/not yet revealed)
              }
              card.targetRotZ = 0;
            }
          } else {
            mesh.visible = false;
          }
        }
      } else {
        // --- PLAYING PHASE: DISPLAY PLAYER'S OWN HAND ---
        const handSize = currentHand.length;
        
        for (let i = 0; i < maxCardMeshes; i++) {
          const card = cardsData[i];
          const mesh = cardMeshes[i];
          if (!mesh) continue;

          if (i < handSize) {
            mesh.visible = true;
            
            // Fanning math based on actual hand size, placed below the camera eye line
            const t = handSize > 1 ? (i - (handSize - 1) / 2) / ((handSize - 1) / 2) : 0;
            
            card.defaultX = t * 0.3; // Tighter, neat horizontal spread for scaled-down cards
            card.defaultY = -1.5 - (t * t) * 0.04; // Placed beautifully at the bottom edge of the screen
            card.defaultZ = 0.9 + (handSize - 1 - i) * 0.03; // Pushed further away from the player (camera at z = 1.7)
            
            card.defaultRotX = -0.45; // Tilted back towards the camera for perfect readability
            card.defaultRotY = 0;
            card.defaultRotZ = -t * 0.1;

            if (hovered === i) {
              // Local hovered card lifts - perfectly framed within viewport
              card.targetX = card.defaultX;
              card.targetY = -1.3; // Lifted slightly, stays well below eye level
              card.targetZ = 1.05; // Pushed further away when hovered (distance 0.65 from camera at 1.7)
              card.targetRotX = -0.25; // Tilted slightly more upright
              card.targetRotY = 0;
              card.targetRotZ = 0;
              card.targetScale = 0.25; // Scaled down for a more spacious, elegant layout
            } else {
              // Return to default fanned
              card.targetX = card.defaultX;
              card.targetY = card.defaultY;
              card.targetZ = card.defaultZ;
              card.targetRotX = card.defaultRotX;
              card.targetRotY = card.defaultRotY;
              card.targetRotZ = card.defaultRotZ;
              card.targetScale = 0.16; // Small, elegant hand cards that don't block anything
            }
          } else if (i === handSize && currentPhase === 'SUBMITTING_CARDS' && hasSubmitted()) {
            // Show the local player's own submitted card lying face-down on the table!
            mesh.visible = true;
            card.targetX = 0;
            card.targetY = -1.65; // On the table surface
            card.targetZ = 0.5; // Pushed further away at the local player's played card slot (radius 1.0 - 0.5)
            card.targetScale = 0.24; // Scaled down to match tabletop card presentation
            card.targetRotX = -0.2; // Tilted slightly for perfect readability
            card.targetRotY = Math.PI; // Face down!
            card.targetRotZ = 0;
          } else {
            mesh.visible = false;
          }
        }
      }

      // Update Caption Card 3D targets based on phase
      if (currentPhase === 'CAPTION_REVEAL') {
        captionCardData.targetX = 0;
        captionCardData.targetY = -1.15; // Raised slightly to stay safely above the table surface
        captionCardData.targetZ = -0.8; // Pulled back to comfortable distance (2.5 units from camera at z = 1.7)
        captionCardData.targetRotX = -0.1; // Tilted slightly back to face the camera
        captionCardData.targetRotY = 0;
        captionCardData.targetRotZ = 0;
      } else if (currentPhase === 'SUBMITTING_CARDS' || currentPhase === 'REVEALING_CARDS' || currentPhase === 'ROUND_RESULTS') {
        captionCardData.targetX = 0.8; // Shifted right in the sky
        captionCardData.targetY = -0.1; // High up in the background sky above the island (relative to camera at -1.1)
        captionCardData.targetZ = -1.8; // Far back in the sky
        captionCardData.targetRotX = 0.12; // Tilted down to face camera
        captionCardData.targetRotY = -0.1; // Angled left to face camera
        captionCardData.targetRotZ = 0;
      } else {
        // WAITING_FOR_CAPTION, GAME_OVER, or not started
        captionCardData.targetX = 0;
        captionCardData.targetY = -6.0; // Deep below the island (hidden)
        captionCardData.targetZ = 0;
        captionCardData.targetRotX = 0;
        captionCardData.targetRotY = 0;
        captionCardData.targetRotZ = 0;
      }

      if (snapImmediately) {
        // Snap hand/submission cards immediately
        cardsData.forEach((card, i) => {
          const mesh = cardMeshes[i];
          if (!mesh) return;
          card.currentX = card.targetX;
          card.currentY = card.targetY;
          card.currentZ = card.targetZ;
          card.currentRotX = card.targetRotX;
          card.currentRotY = card.targetRotY;
          card.currentRotZ = card.targetRotZ;
          card.currentScale = card.targetScale;
          mesh.position.set(card.targetX, card.targetY, card.targetZ);
          mesh.rotation.set(card.targetRotX, card.targetRotY, card.targetRotZ);
          mesh.scale.set(card.targetScale, card.targetScale, card.targetScale);
        });

        // Snap Caption Card immediately
        if (captionCardMesh) {
          captionCardData.currentX = captionCardData.targetX;
          captionCardData.currentY = captionCardData.targetY;
          captionCardData.currentZ = captionCardData.targetZ;
          captionCardData.currentRotX = captionCardData.targetRotX;
          captionCardData.currentRotY = captionCardData.targetRotY;
          captionCardData.currentRotZ = captionCardData.targetRotZ;
          captionCardMesh.position.set(captionCardData.targetX, captionCardData.targetY, captionCardData.targetZ);
          captionCardMesh.rotation.set(captionCardData.targetRotX, captionCardData.targetRotY, captionCardData.targetRotZ);
        }

        // Snap Opponent Avatars immediately
        avatarsData.forEach((info) => {
          info.currentX = info.targetX;
          info.currentY = info.targetY;
          info.currentZ = info.targetZ;
          info.currentRotX = info.targetRotX;
          info.currentRotY = info.targetRotY;
          info.group.position.set(info.targetX, info.targetY, info.targetZ);
          info.group.rotation.set(info.targetRotX, info.targetRotY, 0);

          // Snap opponent hand cards immediately
          if (info.opponentCardMeshes && info.opponentCardData) {
            info.opponentCardMeshes.forEach((mesh, k) => {
              if (!mesh) return;
              const cardData = info.opponentCardData[k];
              cardData.currentX = cardData.targetX;
              cardData.currentY = cardData.targetY;
              cardData.currentZ = cardData.targetZ;
              cardData.currentRotX = cardData.targetRotX;
              cardData.currentRotY = cardData.targetRotY;
              cardData.currentRotZ = cardData.targetRotZ;
              mesh.position.set(cardData.targetX, cardData.targetY, cardData.targetZ);
              mesh.rotation.set(cardData.targetRotX, cardData.targetRotY, cardData.targetRotZ);
            });
          }
        });

        renderFrame();
      } else {
        if (!animationFrameId) {
          animate();
        }
      }
    };

    // Track local hover reactive state
    createEffect(() => {
      updateTargets();
    });

    // Track game phase / hand / submissions and recalculate 3D targets reactively
    createEffect(() => {
      const currentPhase = phase();
      const currentHand = hand();
      submissions();
      revealIndex();

      if (currentPhase !== 'SUBMITTING_CARDS' || hasSubmitted()) {
        setHoveredIndex(null);
      }

      // Snap immediately if entering WAITING_FOR_CAPTION phase (game start or new round start)
      // to bypass animation delays and prevent initial rendering race conditions
      const shouldSnap = currentPhase === 'WAITING_FOR_CAPTION';
      updateTargets(shouldSnap);

      if (gameStarted()) {
        const debugMsg = `Phase: ${currentPhase}, Hand size: ${currentHand.length}, Hand: ${JSON.stringify(currentHand)}, Meshes visible: ${JSON.stringify(cardMeshes.map(m => m.visible))}, Meshes memeId: ${JSON.stringify(cardMeshes.map(m => m.userData.memeId))}, TargetScale: ${JSON.stringify(cardsData.map(d => d.targetScale))}, CurrentScale: ${JSON.stringify(cardsData.map(d => d.currentScale))}`;
        console.log("[DEBUG]", debugMsg);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'DEBUG_LOG',
            message: debugMsg
          }));
        }
      }
    });

    // Track current caption changes and redraw 3D caption card
    createEffect(() => {
      const text = currentCaption();
      if (redrawCaptionCard) {
        redrawCaptionCard(text);
      }
    });

    // SolidJS Reactive Tracking of Player Avatars
    createEffect(() => {
      if (!gameStarted()) {
        avatarsData.forEach((info) => {
          if (info.group.parent) {
            info.group.parent.remove(info.group);
          }
          info.group.traverse(child => {
            if (child.isMesh) {
              child.geometry.dispose();
              child.material.dispose();
            }
          });
        });
        avatarsData.clear();
        return;
      }

      const otherPlayers = players().filter(p => p.id !== playerId());
      
      otherPlayers.forEach((player, index) => {
        let avatarInfo = avatarsData.get(player.id);
        if (!avatarInfo) {
          console.log(`[WebGL] Creating 3D avatar for player: ${player.name}`);
          const group = createPlayerAvatar(player.color);
          scene.add(group);

          // 1. Create Hand Group inside the avatar
          const handGroup = new THREE.Group();
          handGroup.name = "handGroup";
          handGroup.position.set(0, -0.22, 0.18); // Pushed slightly further away from their chest/hands
          group.add(handGroup);

          // Create a pool of 5 card meshes for fanned hand
          const opponentCardMeshes = [];
          const opponentCardData = [];
          const outlineThickness = 0.02;
          
          for (let k = 0; k < 5; k++) {
            const bodyMat = new THREE.MeshStandardMaterial({
              color: 0xffffff,
              roughness: 0.3,
              metalness: 0.0,
              side: THREE.DoubleSide
            });
            const cardMesh = new THREE.Mesh(cardGeometry, bodyMat);
            cardMesh.scale.set(0.16, 0.16, 0.16); // Scaled down to match the new compact card sizes
            cardMesh.visible = false;
            handGroup.add(cardMesh);

            // Outline
            const outlineMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
            const outlineMesh = new THREE.Mesh(cardGeometry, outlineMat);
            outlineMesh.scale.set(1 + outlineThickness, 1 + (outlineThickness * (2/3)), 1 + outlineThickness);
            cardMesh.add(outlineMesh);

            // Card Back
            const backMesh = new THREE.Mesh(backFaceGeometry, backFaceMat);
            backMesh.position.set(0, 0, -0.026);
            backMesh.rotation.y = Math.PI;
            cardMesh.add(backMesh);

            opponentCardMeshes.push(cardMesh);
            opponentCardData.push({
              currentX: 0, currentY: 0, currentZ: 0,
              currentRotX: 0, currentRotY: 0, currentRotZ: 0,
              targetX: 0, targetY: 0, targetZ: 0,
              targetRotX: 0, targetRotY: 0, targetRotZ: 0
            });
          }

          // 2. Create Played Card Mesh (Face-down card on the table in front of their feet)
          const playedCardMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.3,
            metalness: 0.0,
            side: THREE.DoubleSide
          });
          const playedCardMesh = new THREE.Mesh(cardGeometry, playedCardMat);
          playedCardMesh.scale.set(0.24, 0.24, 0.24); // Scaled down to match tabletop card presentation
          playedCardMesh.position.set(0, -0.42, 1.2); // Flat on the table, pushed further out (1.2 units in front)
          playedCardMesh.rotation.set(-Math.PI / 2, 0, 0); // Lying flat
          playedCardMesh.visible = false;
          group.add(playedCardMesh);

          // Outline for played card
          const playedOutlineMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
          const playedOutlineMesh = new THREE.Mesh(cardGeometry, playedOutlineMat);
          playedOutlineMesh.scale.set(1 + outlineThickness, 1 + (outlineThickness * (2/3)), 1 + outlineThickness);
          playedCardMesh.add(playedOutlineMesh);

          // Card Back for played card
          const playedBackMesh = new THREE.Mesh(backFaceGeometry, backFaceMat);
          playedBackMesh.position.set(0, 0, -0.026);
          playedBackMesh.rotation.y = Math.PI;
          playedCardMesh.add(playedBackMesh);
          
          avatarInfo = {
            group,
            handGroup,
            opponentCardMeshes,
            opponentCardData,
            playedCardMesh,
            currentX: 0,
            currentY: 5,
            currentZ: -3,
            targetX: 0,
            targetY: 2,
            targetZ: -0.2,
            currentRotX: 0,
            targetRotX: 0,
            currentRotY: 0,
            targetRotY: 0
          };
          avatarsData.set(player.id, avatarInfo);
        }

        // Position them in their circular campfire spots around the island
        const coords = getPlayerCircleCoords(player.id, 'avatar');
        avatarInfo.targetX = coords.x;
        avatarInfo.targetY = coords.y;
        avatarInfo.targetZ = coords.z;
        avatarInfo.targetRotX = 0; // Standing upright
        avatarInfo.targetRotY = coords.rotY; // Face inward towards center!

        // Update opponent hand cards fanned positions
        const size = player.handSize || 0;
        const hovered = player.hoveredCard;
        avatarInfo.handSize = size;
        avatarInfo.hoveredCard = hovered;

        for (let k = 0; k < 5; k++) {
          const mesh = avatarInfo.opponentCardMeshes[k];
          const data = avatarInfo.opponentCardData[k];
          if (!mesh) continue;

          if (k < size) {
            mesh.visible = true;
            
            // Fanning math in local space
            const t = size > 1 ? (k - (size - 1) / 2) / ((size - 1) / 2) : 0;
            
            data.targetX = t * 0.12;
            data.targetY = - (t * t) * 0.01;
            data.targetZ = (size - 1 - k) * 0.01;
            data.targetRotX = 0.1;
            data.targetRotY = 0;
            data.targetRotZ = -t * 0.15;

            // If opponent is hovering this card, lift it up
            if (hovered === k) {
              data.targetY += 0.08;
              data.targetZ += 0.04;
              data.targetRotX += 0.1;
            }
          } else {
            mesh.visible = false;
          }
        }

        // Show/hide played card on the table based on submission status
        // Only show during submitting phase (since reveal phase uses the global cardMeshes)
        const isSubmitting = phase() === 'SUBMITTING_CARDS';
        avatarInfo.playedCardMesh.visible = isSubmitting && player.hasSubmitted;
      });

      // Clean up removed players
      for (const [pId, info] of avatarsData.entries()) {
        if (!otherPlayers.some(p => p.id === pId)) {
          if (info.group.parent) {
            info.group.parent.remove(info.group);
          }
          info.group.traverse(child => {
            if (child.isMesh) {
              child.geometry.dispose();
              child.material.dispose();
            }
          });
          avatarsData.delete(pId);
        }
      }

      // Trigger animation
      if (!animationFrameId) {
        animate();
      }
    });

    // Resize handler
    const handleResize = () => {
      const width = canvasContainer.clientWidth;
      const height = canvasContainer.clientHeight;
      camera.aspect = width / height;
      
      // Responsive camera zoom: pull back in portrait mode so cards/avatars don't get cut off on the sides
      if (width < height) {
        camera.position.z = 2.15;
        camera.position.y = -1.05;
      } else {
        camera.position.z = 1.7;
        camera.position.y = -1.1;
      }
      
      camera.updateProjectionMatrix();
      camera.lookAt(0, -1.5, -0.5); // Re-align camera rotation to point at the center of campfire circle
      renderer.setSize(width, height);
      renderFrame();
    };
    window.addEventListener('resize', handleResize);
    
    // Call handleResize reactively when game starts and the canvas becomes visible (non-zero dimensions)
    createEffect(() => {
      if (gameStarted()) {
        setTimeout(handleResize, 0);
      }
    });

    onCleanup(() => {
      isCleanedUp = true;
      window.removeEventListener('resize', handleResize);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      if (ws) ws.close();

      avatarsData.forEach((info) => {
        if (info.group.parent) {
          info.group.parent.remove(info.group);
        }
        info.group.traverse(child => {
          if (child.isMesh) {
            child.geometry.dispose();
            child.material.dispose();
          }
        });
      });
      avatarsData.clear();

      cardMeshes.forEach(mesh => {
        const plane = mesh.getObjectByName("imagePlane");
        if (plane) {
          if (plane.material.map) {
            plane.material.map.dispose();
          }
          plane.material.dispose();
        }
      });
      
      // Clean up caption card WebGL resources
      if (captionCardMesh) {
        if (captionCardMesh.parent) {
          captionCardMesh.parent.remove(captionCardMesh);
        }
        captionCardMesh.traverse(child => {
          if (child.isMesh) {
            if (child.material.map) {
              child.material.map.dispose();
            }
            child.material.dispose();
            child.geometry.dispose();
          }
        });
      }
      captionCardGeo.dispose();
      captionCardMat.dispose();
      captionOutlineMat.dispose();
      captionFaceGeo.dispose();
      captionFaceMat.dispose();
      captionTexture.dispose();

      // Clean up card back WebGL resources
      cardBackTexture.dispose();
      backFaceGeometry.dispose();
      backFaceMat.dispose();

      renderer.dispose();
      cardGeometry.dispose();
      imageGeometry.dispose();
      imageOutlineGeometry.dispose();
      imageOutlineMaterial.dispose();
      cardMaterials.forEach(m => m.dispose());
      cardOutlineMaterials.forEach(m => m.dispose());
      imageMaterials.forEach(m => m.dispose());
      canvasContainer.innerHTML = ''; 
    });
  });

  // --- MULTIPLAYER VISUAL OUTLINE TRIGGER ---
  createEffect(() => {
    const playersList = players();
    if (!cardOutlineMaterials || cardOutlineMaterials.length === 0) return;

    // Reset outlines to black
    cardOutlineMaterials.forEach(mat => {
      if (mat) mat.color.setHex(0x000000);
    });

    const currentPhase = phase();
    const inReveal = currentPhase === 'REVEALING_CARDS' || currentPhase === 'ROUND_RESULTS';

    // Outline hover indicators: Only active during play/submitting (not reveal)
    if (!inReveal) {
      const local = playersList.find(p => p.id === playerId());
      if (local && local.hoveredCard !== null && local.hoveredCard >= 0 && local.hoveredCard < cardOutlineMaterials.length) {
        const mat = cardOutlineMaterials[local.hoveredCard];
        if (mat) {
          mat.color.setStyle(local.color);
        }
      }
    }

    if (renderFrame) renderFrame();
  });

  let lastProcessedPhase = null;

  // --- SOLIDJS TEXTURE SYNC EFFECT ---
  createEffect(() => {
    if (!gameStarted()) return;
    const currentPhase = phase();

    if (currentPhase === 'REVEALING_CARDS' || currentPhase === 'ROUND_RESULTS') {
      const subs = submissions();
      subs.forEach((sub, i) => {
        const mesh = cardMeshes[i];
        if (mesh && sub.memeId && mesh.userData.memeId !== sub.memeId) {
          mesh.userData.memeId = sub.memeId;
          const url = `${API_BASE}/api/meme?id=${encodeURIComponent(sub.memeId)}`;
          if (loadCardTexture) {
            loadCardTexture(i, url);
          }
        }
      });
    } else {
      // Only clear the mesh cache when transitioning into WAITING_FOR_CAPTION (start of a round / new game)
      // to prevent repeatedly clearing cache on every lobby state update during this phase.
      if (currentPhase === 'WAITING_FOR_CAPTION' && lastProcessedPhase !== 'WAITING_FOR_CAPTION') {
        cardMeshes.forEach(mesh => {
          if (mesh) mesh.userData.memeId = undefined;
        });
      }

      const myHand = hand();
      myHand.forEach((memeId, i) => {
        const mesh = cardMeshes[i];
        if (mesh && memeId && mesh.userData.memeId !== memeId) {
          mesh.userData.memeId = memeId;
          const url = `${API_BASE}/api/meme?id=${encodeURIComponent(memeId)}`;
          if (loadCardTexture) {
            loadCardTexture(i, url);
          }
        }
      });
    }

    lastProcessedPhase = currentPhase;
  });

  // --- HANDLE LOCAL ACTIONS (BROADCAST TO WS) ---
  const handleLocalHover = (index) => {
    // Hovering only active during play phase
    const inReveal = phase() === 'REVEALING_CARDS' || phase() === 'ROUND_RESULTS';
    if (inReveal) return;

    setHoveredIndex(index);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'HOVER_CARD',
        cardIndex: index
      }));
    }
  };

  const handleLocalCardClick = (index) => {
    if (phase() !== 'SUBMITTING_CARDS') return;
    if (isActiveDrawer()) return;
    if (hasSubmitted()) return;

    // Tap-to-preview, tap-again-to-submit logic for mobile and desktop harmony
    if (hoveredIndex() !== index) {
      handleLocalHover(index);
      return;
    }

    // Reset local hover immediately for visual responsiveness
    setHoveredIndex(null);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'HOVER_CARD',
        cardIndex: null
      }));
      ws.send(JSON.stringify({
        type: 'SUBMIT_CARD',
        cardIndex: index
      }));
    }
  };

  // --- GAME LOBBY HELPERS ---
  const isHost = () => {
    const local = players().find(p => p.id === playerId());
    return local ? local.isHost : false;
  };

  const isActiveDrawer = () => {
    const pList = players();
    const idx = activePlayerIdx();
    if (idx >= 0 && idx < pList.length) {
      return pList[idx].id === playerId();
    }
    return false;
  };

  const getActiveDrawerName = () => {
    const pList = players();
    const idx = activePlayerIdx();
    if (idx >= 0 && idx < pList.length) {
      return pList[idx].name;
    }
    return 'Active Drawer';
  };

  const hasSubmitted = () => {
    const local = players().find(p => p.id === playerId());
    return local ? local.hasSubmitted : false;
  };

  const hasVotedCurrent = () => {
    const subs = submissions();
    const idx = revealIndex();
    if (idx >= 0 && idx < subs.length) {
      return subs[idx].hasVoted;
    }
    return false;
  };

  const getCurrentVotesCount = () => {
    const subs = submissions();
    const idx = revealIndex();
    if (idx >= 0 && idx < subs.length) {
      return subs[idx].ratingsCount || 0;
    }
    return 0;
  };

  const getWinnerName = () => {
    const wId = winnerId();
    const wPlayer = players().find(p => p.id === wId);
    return wPlayer ? wPlayer.name : 'Unknown';
  };

  const getWinnerPoints = () => {
    const wId = winnerId();
    const wPlayer = players().find(p => p.id === wId);
    return wPlayer ? wPlayer.points : 5;
  };

  return (
    <div 
      style={{ 
        position: "relative", 
        width: "100vw", 
        height: "100vh", 
        overflow: "hidden",
        background: "#0a0a0c",
        userSelect: "none"
      }}
      onTouchStart={() => handleLocalHover(null)}
      onClick={() => handleLocalHover(null)}
    >
      {/* Connection Status Banner */}
      <Show when={socketStatus() === 'CONNECTING' || (inLobby() && socketStatus() === 'DISCONNECTED')}>
        <div style={{
          position: "absolute",
          top: "0",
          left: "0",
          width: "100vw",
          background: socketStatus() === 'CONNECTING' ? "#ffca28" : "#ff1744",
          color: "#000",
          "text-align": "center",
          padding: "6px",
          "font-size": "12px",
          "font-weight": "700",
          "z-index": "2000",
          "border-bottom": "3px solid #000",
          "font-family": "var(--font-sans)"
        }}>
          {socketStatus() === 'CONNECTING' 
            ? "Connecting to server... (Render wake-up can take up to 60 seconds)" 
            : "Disconnected from server. Retrying..."}
        </div>
      </Show>

      {/* Fullscreen Floating Toggle Button */}
      <button 
        class="fullscreen-toggle-btn" 
        onClick={(e) => {
          e.stopPropagation();
          toggleFullscreen();
        }}
        title="Toggle Fullscreen"
      >
        <Show when={isFullscreen()} fallback={
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
          </svg>
        }>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 14h6v6m10-6h-6v6M4 10h6V4m10 6h-6V4"/>
          </svg>
        </Show>
      </button>
      {/* 3D WebGL Canvas (Always in DOM, visible only when game started) */}
      <div 
        ref={canvasContainer} 
        style={{ 
          width: "100%", 
          height: "100%", 
          overflow: "hidden",
          display: gameStarted() ? "block" : "none" 
        }} 
      />

      {/* --- MULTIPLAYER ROOM SETUP SCREEN (WELCOME) --- */}
      <Show when={!inLobby()}>
        <div class="lobby-screen">
          <div class="silly-panel">
            <h1 class="lobby-title">cardsAndFarts</h1>
            <p class="lobby-subtitle">The Simplest &amp; Silliest Card Game!</p>

            <div class="input-group">
              <label class="input-label">Enter your name</label>
              <input 
                type="text" 
                class="silly-input"
                value={playerName()} 
                onInput={(e) => setPlayerName(e.target.value)} 
                maxLength="14"
                placeholder="Name..."
              />
            </div>

            <div class="input-group">
              <label class="input-label">Room Password/Code</label>
              <input 
                type="text" 
                class="silly-input" 
                style={{ "text-transform": "uppercase" }}
                value={inputLobbyId()} 
                onInput={(e) => setInputLobbyId(e.target.value)} 
                placeholder="4-LETTER CODE"
                maxLength="4"
              />
            </div>

            <div class="button-row">
              <button class="silly-button silly-button-secondary" onClick={handleCreateLobby}>
                Host Game
              </button>
              <button class="silly-button" onClick={handleJoinLobby}>
                Join Game
              </button>
            </div>

            <Show when={errorMsg()}>
              <div class="error-message">{errorMsg()}</div>
            </Show>
          </div>
        </div>
      </Show>

      {/* --- MULTIPLAYER LOBBY WAITING ROOM --- */}
      <Show when={inLobby() && !gameStarted()}>
        <div class="lobby-screen">
          <div class="silly-panel" style={{ transform: "rotate(1deg)" }}>
            <h1 class="lobby-title">Lobby</h1>
            <p class="lobby-subtitle">Invite others with this secret code:</p>

            <div class="lobby-code-box" id="copy-btn" onClick={copyRoomCode}>
              {lobbyId()}
            </div>

            <label class="input-label" style={{ "text-align": "left" }}>peoples:</label>
            <div class="player-list" style={{ "max-height": "180px" }}>
              <For each={players()}>
                {(player) => (
                  <div class="player-row">
                    <div class="player-info">
                      <div class="player-color-dot" style={{ color: player.color, "background-color": player.color }} />
                      <span class="player-name">{player.name} {player.id === playerId() ? "(You)" : ""}</span>
                    </div>
                    <Show when={player.isHost}>
                      <span class="player-tag">Host</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>

            <div class="button-row" style={{ "flex-direction": "column", "gap": "10px" }}>
              <Show when={isHost()} fallback={
                <div style={{ "text-align": "center", "margin": "10px 0" }}>
                  <span class="silly-spinner">...</span>
                  <div class="input-label">Waiting for the next player to start...</div>
                </div>
              }>
                <button class="silly-button silly-button-secondary" style={{ width: "100%" }} onClick={handleStartGame}>
                  Start
                </button>
              </Show>
              
              <button class="silly-button" style={{ background: "#ff1744", width: "100%" }} onClick={leaveLobby}>
                Run Away
              </button>
            </div>

            <Show when={errorMsg()}>
              <div class="error-message">{errorMsg()}</div>
            </Show>
          </div>
        </div>
      </Show>

      {/* --- ACTIVE GAME IN-GAME HUD OVERLAY --- */}
      <Show when={inLobby() && gameStarted() && phase() !== 'GAME_OVER'}>
        <div class="hud-container">
          {/* Top HUD */}
          <div class="hud-header">
            <div class="hud-title-box">
              <h2 class="hud-title">cardsAndFarts</h2>
              <div class="hud-code">Room: {lobbyId()}</div>
            </div>

            {/* Players list with points and status */}
            <div class="hud-players-box">
              <div class="input-label" style={{ "font-size": "12px", "margin-bottom": "4px" }}>Points:</div>
              <For each={players()}>
                {(player) => (
                  <div class="hud-player-item">
                    <div class="hud-player-name-container">
                      <div class="player-color-dot" style={{ width: "8px", height: "8px", color: player.color, "background-color": player.color }} />
                      <span style={{ "font-weight": player.id === playerId() ? "700" : "400", "font-size": "12px" }}>
                        {player.name}
                      </span>
                    </div>
                    <div style={{ "display": "flex", "align-items": "center", "gap": "4px" }}>
                      <span style={{ "font-weight": "800", "font-size": "12px" }}>{player.points} pts</span>
                      <Show when={phase() === 'SUBMITTING_CARDS' && player.id !== players()[activePlayerIdx()]?.id}>
                        <span style={{ "font-size": "12px" }}>{player.hasSubmitted ? "Ready" : "Waiting"}</span>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>

          {/* Bottom HUD */}
          <div class="hud-footer">
            <button class="hud-leave-button" onClick={leaveLobby}>
              Leave Room
            </button>
          </div>
        </div>

        {/* --- DYNAMIC PHASE-SPECIFIC GAME MENUS (Sleek, Compact Left Sidebar) --- */}
        <div class="sidebar-panel">
          {/* 1. WAITING FOR CAPTION PHASE */}
          <Show when={phase() === 'WAITING_FOR_CAPTION'}>
            <div class="silly-panel" style={{ transform: "rotate(-1deg)" }}>
              <h2 class="lobby-title" style={{ "font-size": "18px", "margin-bottom": "4px" }}>Drawing Phase</h2>
              <p class="lobby-subtitle" style={{ "font-size": "12px", "margin-bottom": "12px", "color": "#5b21b6" }}>
                {isActiveDrawer() 
                  ? "Picking a caption card!" 
                  : `Waiting for ${getActiveDrawerName()} to draw a caption...`}
              </p>
              
              <Show when={isActiveDrawer()} fallback={
                <div style={{ "margin": "6px 0", "text-align": "center" }}>
                  <span class="silly-spinner" style={{ "font-size": "18px" }}>...</span>
                  <div class="input-label" style={{ "font-size": "10px" }}>Fingers crossed...</div>
                </div>
              }>
                <button class="silly-button silly-button-secondary" style={{ width: "100%", padding: "8px", "font-size": "14px" }} onClick={handleDrawCaption}>
                  Draw a Caption
                </button>
              </Show>
            </div>
          </Show>

          {/* 1.5 CHOOSING CAPTION PHASE */}
          <Show when={phase() === 'CHOOSING_CAPTION'}>
            <div class="silly-panel" style={{ transform: "rotate(1deg)" }}>
              <h2 class="lobby-title" style={{ "font-size": "18px", "margin-bottom": "4px" }}>Choose a Caption</h2>
              
              <Show when={isActiveDrawer()} fallback={
                <div style={{ "text-align": "center", "padding": "10px 0" }}>
                  <span class="silly-spinner" style={{ "font-size": "20px" }}>...</span>
                  <p class="lobby-subtitle" style={{ "font-size": "12px", "color": "#5b21b6", "margin-top": "8px" }}>
                    {getActiveDrawerName()} is choosing captions...
                  </p>
                </div>
              }>
                <p class="lobby-subtitle" style={{ "font-size": "11px", "margin-bottom": "10px", "color": "#5b21b6" }}>
                  Pick the funniest caption for this round!
                </p>
                <div style={{ "display": "flex", "flex-direction": "column", "gap": "10px" }}>
                  <For each={captionOptions()}>
                    {(option) => (
                      <button 
                        class="silly-button" 
                        style={{ 
                          "width": "100%", 
                          "padding": "10px 12px", 
                          "font-size": "12px", 
                          "line-height": "1.4",
                          "text-align": "left",
                          "background": "#ffca28",
                          "color": "#000",
                          "border": "3px solid #000",
                          "box-shadow": "3px 3px 0px #000",
                          "white-space": "normal"
                        }} 
                        onClick={() => handleSelectCaption(option)}
                      >
                        {option}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          {/* 2. CAPTION_REVEAL PHASE (7s timer) */}
          <Show when={phase() === 'CAPTION_REVEAL'}>
            <div class="silly-panel" style={{ transform: "rotate(1deg)" }}>
              <h2 class="lobby-title" style={{ "font-size": "18px", "color": "#ff4081", "margin-bottom": "4px" }}>Caption Drawn</h2>
              <p class="lobby-subtitle" style={{ "font-size": "11px", "margin-bottom": "8px", "color": "#5b21b6" }}>Read the 3D card, get ready</p>
              
              <div 
                style={{
                  background: "#fff",
                  border: "2px solid #000",
                  "border-radius": "50%",
                  width: "44px",
                  height: "44px",
                  display: "flex",
                  "justify-content": "center",
                  "align-items": "center",
                  "font-size": "18px",
                  "font-weight": "800",
                  margin: "6px auto",
                  "box-shadow": "2px 2px 0px #000"
                }}
              >
                {captionRevealTimer()}
              </div>
              <div class="input-label" style={{ "font-size": "10px", "text-align": "center" }}>Playing starts in a flash</div>
            </div>
          </Show>

          {/* 3. SUBMITTING_CARDS PHASE (30s timer) */}
          <Show when={phase() === 'SUBMITTING_CARDS'}>
            <Show when={hasSubmitted()} fallback={
              <Show when={isActiveDrawer()} fallback={
                // Active player must submit a card
                <div 
                  class="silly-panel" 
                  style={{ 
                    transform: "rotate(-1.5deg)",
                    background: "#00e676", 
                    border: "3px solid #000",
                    "box-shadow": "4px 4px 0px #000"
                  }}
                >
                  <h2 class="lobby-title" style={{ "font-size": "18px", "text-shadow": "none" }}>Pick Your Meme</h2>
                  <p class="lobby-subtitle" style={{ "color": "#000", "margin-bottom": "6px", "font-size": "11px" }}>
                    Select a card below to fit the caption
                  </p>
                  
                  <div style={{ "display": "flex", "align-items": "center", "gap": "6px", "margin-top": "6px" }}>
                    <div style={{ "font-size": "15px", "font-weight": "800" }}>{submissionTimer()}s left</div>
                  </div>
                </div>
              }>
                {/* Active drawer waiting */}
                <div class="silly-panel" style={{ transform: "rotate(1deg)" }}>
                  <h2 class="lobby-title" style={{ "font-size": "18px" }}>You are Judge</h2>
                  <p class="lobby-subtitle" style={{ "margin-bottom": "8px", "color": "#5b21b6", "font-size": "11px" }}>
                    Waiting for players to submit memes...
                  </p>
                  <div class="waiting-spinner" style={{ "border-top-color": "#000", "margin-bottom": "6px", "width": "20px", "height": "20px" }} />
                  <div class="input-label" style={{ "font-size": "10px" }}>Time remaining: {submissionTimer()}s</div>
                </div>
              </Show>
            }>
              {/* Submitted, waiting for others */}
              <div class="silly-panel" style={{ transform: "rotate(1deg)" }}>
                <h2 class="lobby-title" style={{ "font-size": "18px" }}>Submitted</h2>
                <p class="lobby-subtitle" style={{ "margin-bottom": "8px", "color": "#5b21b6", "font-size": "11px" }}>
                  Meme is in pile! Waiting for others
                </p>
                <div class="waiting-spinner" style={{ "border-top-color": "#000", "margin-bottom": "6px", "width": "20px", "height": "20px" }} />
                <div class="input-label" style={{ "font-size": "10px" }}>Time remaining: {submissionTimer()}s</div>
              </div>
            </Show>
          </Show>

          {/* 4. REVEALING_CARDS PHASE */}
          <Show when={phase() === 'REVEALING_CARDS'}>
            <div class="silly-panel" style={{ transform: "rotate(-1deg)", background: "#ffca28" }}>
              <h2 class="lobby-title" style={{ "font-size": "18px", "text-shadow": "none" }}>Rate this Meme</h2>
              <p class="lobby-subtitle" style={{ "color": "#5b21b6", "margin-bottom": "8px", "font-size": "11px" }}>
                Meme {revealIndex() + 1} of {submissions().length}
              </p>
              
              {/* Star Rating Buttons */}
              <Show when={hasVotedCurrent()} fallback={
                <div>
                  <div style={{ "display": "flex", "justify-content": "center", "gap": "4px", "margin": "10px 0" }}>
                    <For each={[1, 2, 3, 4, 5]}>
                      {(star) => (
                        <button 
                          class="silly-button" 
                          style={{ 
                            "flex": "none", 
                            width: "36px", 
                            height: "32px", 
                            padding: "0", 
                            background: "#ff4081",
                            "font-size": "12px"
                          }}
                          onClick={() => handleLocalVote(star)}
                        >
                          {star}★
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="input-label" style={{ "font-size": "9px", "text-align": "center" }}>Click a star to cast your vote!</div>
                </div>
              }>
                <div style={{ "margin": "10px 0", "text-align": "center" }}>
                  {/* <div style={{ "font-size": "24px" }}></div> */}
                  <div class="input-label" style={{ "font-size": "10px", "color": "#000" }}>Your vote is in!</div>
                </div>
              </Show>

              <div 
                style={{ 
                  "font-size": "9px", 
                  "font-weight": "700", 
                  background: "#fff", 
                  border: "2px solid #000", 
                  padding: "2px 6px", 
                  "border-radius": "5px",
                  display: "block",
                  "margin-top": "6px",
                  "text-align": "center"
                }}
              >
                Votes Cast: {getCurrentVotesCount()} / {players().length}
              </div>
            </div>
          </Show>

          {/* 5. ROUND_RESULTS PHASE */}
          <Show when={phase() === 'ROUND_RESULTS'}>
            <div class="silly-panel" style={{ transform: "rotate(1deg)", width: "100%" }}>
              <h2 class="lobby-title" style={{ "font-size": "18px" }}>Round Results</h2>
              <p class="lobby-subtitle" style={{ "margin-bottom": "8px", "color": "#5b21b6", "font-size": "11px" }}>Meme scores this round:</p>
              
              <div class="player-list" style={{ "max-height": "100px", "margin": "8px 0" }}>
                <For each={submissions()}>
                  {(sub) => {
                    const maxRating = Math.max(...submissions().map(s => s.averageRating));
                    const isWinner = sub.averageRating === maxRating;
                    return (
                      <div class="player-row" style={{ "padding": "4px 8px", background: isWinner ? "#fffde7" : "#fff", "border-color": isWinner ? "#ffca28" : "#000" }}>
                        <div class="player-info">
                          <span class="player-name" style={{ "font-weight": "700", "font-size": "11px" }}>
                            {sub.playerName}'s Meme
                          </span>
                        </div>
                        <div style={{ "display": "flex", "align-items": "center", "gap": "4px" }}>
                          <span style={{ "font-weight": "800", "font-size": "11px" }}>{sub.averageRating}★</span>
                          <Show when={isWinner}>
                            <span class="player-tag" style={{ background: "#ffca28", border: "1px solid #000", "font-size": "8px", padding: "1px 3px" }}>WIN</span>
                          </Show>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>

              <div class="input-label" style={{ "text-align": "left", "margin-top": "8px", "margin-bottom": "2px", "font-size": "10px" }}>Scores:</div>
              <div class="player-list" style={{ "max-height": "80px", "margin-top": "0", "gap": "2px" }}>
                <For each={players()}>
                  {(player) => (
                    <div style={{ "display": "flex", "justify-content": "space-between", "align-items": "center", "font-size": "11px", "padding": "1px 4px" }}>
                      <div style={{ "display": "flex", "align-items": "center", "gap": "4px" }}>
                        <div class="player-color-dot" style={{ width: "6px", height: "6px", color: player.color, "background-color": player.color }} />
                        <span style={{ "font-weight": "700" }}>{player.name}</span>
                      </div>
                      <div style={{ "font-weight": "800" }}>{player.points} pts</div>
                    </div>
                  )}
                </For>
              </div>

              <div class="button-row" style={{ "margin-top": "10px" }}>
                <Show when={isHost()} fallback={
                  <div style={{ "text-align": "center", "width": "100%", "margin": "2px 0" }}>
                    <span class="silly-spinner" style={{ "font-size": "14px" }}>...</span>
                    <div class="input-label" style={{ "font-size": "9px" }}>Waiting for Host...</div>
                  </div>
                }>
                  <button class="silly-button silly-button-secondary" style={{ width: "100%", padding: "6px", "font-size": "13px" }} onClick={handleNextRound}>
                    Next Round
                  </button>
                </Show>
              </div>
            </div>
          </Show>
        </div>


      </Show>

      {/* --- GAME OVER VICTORY SCREEN OVERLAY --- */}
      <Show when={inLobby() && gameStarted() && phase() === 'GAME_OVER'}>
        <div class="lobby-screen">
          <div class="silly-panel" style={{ transform: "rotate(-1deg)", width: "440px", background: "#00e676" }}>
            <h1 class="lobby-title" style={{ "font-size": "30px", "text-shadow": "none" }}>Game Over</h1>
            <p class="lobby-subtitle" style={{ "color": "#000", "font-weight": "800", "margin-bottom": "12px" }}>
              absolute loser found
            </p>

            <div 
              style={{
                background: "#fff",
                border: "4px solid #000",
                "border-radius": "16px",
                padding: "16px",
                margin: "16px 0",
                "box-shadow": "6px 6px 0px #000"
              }}
            >
              <div style={{ "font-size": "12px", "font-weight": "700", "text-transform": "uppercase", "color": "#ff4081" }}>
                GRAND CHAMPION
              </div>
              <div style={{ "font-size": "26px", "font-weight": "800", "color": "#000", "margin": "6px 0" }}>
                {getWinnerName()}
              </div>
              <div style={{ "font-size": "15px", "font-weight": "700", "color": "#5b21b6" }}>
                Score: {getWinnerPoints()} Points!
              </div>
            </div>

            <div class="input-label" style={{ "text-align": "left", "margin-bottom": "4px" }}>Final Standings:</div>
            <div class="player-list" style={{ "max-height": "120px", "margin-top": "0" }}>
              <For each={players()}>
                {(player) => (
                  <div class="player-row" style={{ "padding": "6px 12px" }}>
                    <div class="player-info">
                      <div class="player-color-dot" style={{ color: player.color, "background-color": player.color }} />
                      <span class="player-name" style={{ "font-weight": "700", "font-size": "14px" }}>{player.name}</span>
                    </div>
                    <span style={{ "font-weight": "800", "font-size": "14px" }}>{player.points} pts</span>
                  </div>
                )}
              </For>
            </div>

            <div class="button-row" style={{ "margin-top": "16px" }}>
              <Show when={isHost()} fallback={
                <div style={{ "text-align": "center", "width": "100%", "margin": "8px 0" }}>
                  <span class="silly-spinner">...</span>
                  <div class="input-label">Waiting for Host to restart...</div>
                </div>
              }>
                <button class="silly-button silly-button-secondary" style={{ width: "100%" }} onClick={handlePlayAgain}>
                  Play Again
                </button>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      {/* Stationary Hitboxes for Hover and Click Detection */}
      {/* Anti-collision: Only rendered/interactive when the player actually needs to choose a card! */}
      <Show when={inLobby() && gameStarted() && phase() === 'SUBMITTING_CARDS' && !hasSubmitted() && !isActiveDrawer()}>
        <div class="hand-hitboxes">
          <For each={Array(hand().length)}>
            {(_, index) => {
              const i = index();
              return (
                <div 
                  class="hitbox-item"
                  data-card-index={i}
                  onMouseEnter={() => handleLocalHover(i)}
                  onMouseLeave={() => handleLocalHover(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLocalCardClick(i);
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault(); // Prevent simulated mouse/click events
                    e.stopPropagation();
                    
                    const isAlreadyHovered = hoveredIndex() === i;
                    alreadyHoveredBeforeTouch = isAlreadyHovered;
                    touchStartCard = i;
                    
                    handleLocalHover(i);
                  }}
                  onTouchMove={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const touch = e.touches[0];
                    const element = document.elementFromPoint(touch.clientX, touch.clientY);
                    if (element) {
                      const cardIndexAttr = element.getAttribute('data-card-index');
                      if (cardIndexAttr !== null) {
                        const cardIndex = parseInt(cardIndexAttr, 10);
                        if (hoveredIndex() !== cardIndex) {
                          handleLocalHover(cardIndex);
                        }
                      } else {
                        // Dragged outside card hitboxes
                        if (hoveredIndex() !== null) {
                          handleLocalHover(null);
                        }
                      }
                    } else {
                      if (hoveredIndex() !== null) {
                        handleLocalHover(null);
                      }
                    }
                  }}
                  onTouchEnd={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    const touch = e.changedTouches[0];
                    const element = document.elementFromPoint(touch.clientX, touch.clientY);
                    if (element) {
                      const cardIndexAttr = element.getAttribute('data-card-index');
                      if (cardIndexAttr !== null) {
                        const cardIndex = parseInt(cardIndexAttr, 10);
                        
                        // If they released on the same card they started, and it was already hovered, submit it
                        if (cardIndex === touchStartCard && alreadyHoveredBeforeTouch) {
                          setHoveredIndex(null);
                          if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                              type: 'HOVER_CARD',
                              cardIndex: null
                            }));
                            ws.send(JSON.stringify({
                              type: 'SUBMIT_CARD',
                              cardIndex: cardIndex
                            }));
                          }
                        }
                      } else {
                        // Released outside card hitboxes
                        handleLocalHover(null);
                      }
                    } else {
                      handleLocalHover(null);
                    }
                    
                    // Reset gesture tracking
                    touchStartCard = null;
                    alreadyHoveredBeforeTouch = false;
                  }}
                />
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

// --- SILLY GOOGLY-EYED AVATAR GENERATOR ---
function createPlayerAvatar(playerColor) {
  const group = new THREE.Group();

  // 1. Head: perfectly round sphere for a clean cartoon look
  const headGeo = new THREE.SphereGeometry(0.2, 16, 16); // Perfectly round head (no vertical squash)
  const headMat = new THREE.MeshStandardMaterial({ 
    color: new THREE.Color(playerColor),
    roughness: 0.5,
    flatShading: true
  });
  const head = new THREE.Mesh(headGeo, headMat);
  group.add(head);

  // 2. Flat Eyes (White Backing + Black Pupils sitting flush on the head)
  const eyeGeo = new THREE.SphereGeometry(0.055, 16, 16);
  eyeGeo.scale(1, 1, 0.45); // Slightly thicker button shape to prevent clipping
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  
  const pupilGeo = new THREE.SphereGeometry(0.026, 12, 12);
  pupilGeo.scale(1, 1, 0.3); // Slightly thicker pupil
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x111111 });

  // Left Eye
  const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
  leftEye.position.set(-0.07, 0.04, 0.186); // Pushed forward to sit cleanly on the head surface
  leftEye.rotation.set(-0.1, 0.35, 0); // Rotated to lie flush on the curved head
  leftEye.name = "leftEye";
  group.add(leftEye);

  const leftPupil = new THREE.Mesh(pupilGeo, pupilMat);
  leftPupil.position.set(0.01, 0, 0.05); // Positioned slightly inward (derpy/cute) and sitting flush
  leftPupil.name = "leftPupil";
  leftEye.add(leftPupil); // Added as child of the eye so it inherits transforms

  // Right Eye
  const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
  rightEye.position.set(0.07, 0.04, 0.186); // Pushed forward
  rightEye.rotation.set(-0.1, -0.35, 0);
  rightEye.name = "rightEye";
  group.add(rightEye);

  const rightPupil = new THREE.Mesh(pupilGeo, pupilMat);
  rightPupil.position.set(-0.01, 0, 0.05); // Inward gaze
  rightPupil.name = "rightPupil";
  rightEye.add(rightPupil);



  // 4. Short, Chubby Body (Soft bean/egg shape)
  const bodyGeo = new THREE.SphereGeometry(0.15, 16, 16);
  bodyGeo.scale(1, 1.25, 0.9);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(playerColor),
    roughness: 0.6,
    flatShading: true
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = -0.22; // Below the head, slightly overlapping
  group.add(body);

  // 5. Tiny Stubby Shoes
  const footGeo = new THREE.SphereGeometry(0.045, 12, 12);
  footGeo.scale(1, 0.6, 1.3); // Flattened and elongated shoes
  const footMat = new THREE.MeshStandardMaterial({ 
    color: 0x2e2e2e, // Soft dark charcoal
    roughness: 0.8,
    flatShading: true 
  });

  const leftFoot = new THREE.Mesh(footGeo, footMat);
  leftFoot.position.set(-0.07, -0.37, 0.05);
  leftFoot.rotation.set(0.1, 0.2, 0); // Pointing slightly outward
  group.add(leftFoot);

  const rightFoot = new THREE.Mesh(footGeo, footMat);
  rightFoot.position.set(0.07, -0.37, 0.05);
  rightFoot.rotation.set(0.1, -0.2, 0);
  group.add(rightFoot);

  return group;
}

export default SandBox;
