import * as THREE from '../extras/three'
import { System } from './System'
import { ControlPriorities } from '../extras/ControlPriorities'
import { bindRotations } from '../extras/bindRotations'
import { clamp } from '../utils'

const DEG2RAD = Math.PI / 180
const POINTER_LOOK_SPEED = 0.1
const FREECAM_SPEED = 10
const FREECAM_FAST_SPEED = 25
const ORBIT_DISTANCE = 5
const ORBIT_MIN_DISTANCE = 1.5
const ORBIT_MAX_DISTANCE = 20
const ZOOM_SPEED = 2
const ORBIT_HEIGHT_OFFSET = 1.5

const UP = new THREE.Vector3(0, 1, 0)
const v1 = new THREE.Vector3()

/**
 * Spectator Camera System
 *
 * - Runs on the browser client in spectator mode
 * - Two modes: Agent Focus (orbit around agent) and Freecam (fly freely)
 * - C to toggle modes, LMB/RMB to cycle agents
 *
 */
export class SpectatorCamera extends System {
  constructor(world) {
    super(world)
    this.mode = 'agentFocus' // 'agentFocus' | 'freecam'
    this.focusedAgentId = null
    this.agentIds = []
    this.agentIndex = 0

    // Camera state
    this.position = new THREE.Vector3(0, 5, 10)
    this.quaternion = new THREE.Quaternion()
    this.rotation = new THREE.Euler(0, 0, 0, 'YXZ')
    bindRotations(this.quaternion, this.rotation)

    // Orbit state
    this.orbitDistance = ORBIT_DISTANCE
    this.orbitYaw = 0
    this.orbitPitch = -15 * DEG2RAD

    // Control binding
    this.control = null
    this.active = false
  }

  start() {
    // Only activate after snapshot is received and spectator mode confirmed
    this.world.on('ready', () => {
      if (!this.world.network.isSpectator) return
      this.activate()
    })
  }

  activate() {
    this.active = true
    this.control = this.world.controls.bind({
      priority: ControlPriorities.PLAYER,
    })
    this.control.camera.write = true
    this.control.camera.position.copy(this.position)
    this.control.camera.quaternion.copy(this.quaternion)
    this.control.camera.zoom = 0

    // C = toggle between Agent Focus and Freecam
    this.control.keyC.onPress = () => {
      this.toggleMode()
    }

    // ~ = toggle HUD visibility
    this.control.backquote.onPress = () => {
      this.world.emit('spectator-hud-toggle')
    }

    // Pointer lock on left click, or cycle agent prev when locked in agent focus
    this.control.mouseLeft.onPress = () => {
      if (!this.control.pointer.locked) {
        this.control.pointer.lock()
      } else if (this.mode === 'agentFocus') {
        this.cycleAgent(-1)
      }
    }

    // Right click cycles agent next when locked in agent focus
    this.control.mouseRight.onPress = () => {
      if (this.control.pointer.locked && this.mode === 'agentFocus') {
        this.cycleAgent(1)
      }
    }

    // Listen for agent entity changes
    this.world.entities.on('added', this.onEntityAdded)
    this.world.entities.on('removed', this.onEntityRemoved)

    // Build initial agent list from already-connected agents
    this.refreshAgentList()
    if (this.agentIds.length > 0) {
      this.focusedAgentId = this.agentIds[0]
      this.agentIndex = 0
    }

    this.emitModeInfo()
  }

  onEntityAdded = (entity) => {
    if (entity.isPlayer && entity.isRemote) {
      this.refreshAgentList()
      // Auto-focus first agent if none focused
      if (!this.focusedAgentId && this.agentIds.length > 0) {
        this.focusedAgentId = this.agentIds[0]
        this.agentIndex = 0
        this.emitModeInfo()
      }
    }
  }

  onEntityRemoved = (entity) => {
    if (entity.isPlayer) {
      const wasWatching = this.focusedAgentId === entity.data.id
      this.refreshAgentList()
      if (wasWatching) {
        if (this.agentIds.length > 0) {
          this.agentIndex = this.agentIndex % this.agentIds.length
          this.focusedAgentId = this.agentIds[this.agentIndex]
        } else {
          this.focusedAgentId = null
          this.agentIndex = 0
        }
        this.emitModeInfo()
      }
    }
  }

  refreshAgentList() {
    this.agentIds = []
    this.world.entities.players.forEach((entity, id) => {
      this.agentIds.push(id)
    })
  }

  cycleAgent(direction) {
    if (this.agentIds.length === 0) return
    this.agentIndex = (this.agentIndex + direction + this.agentIds.length) % this.agentIds.length
    this.focusedAgentId = this.agentIds[this.agentIndex]
    this.emitModeInfo()
  }

  toggleMode() {
    if (this.mode === 'agentFocus') {
      this.mode = 'freecam'
      // Snap freecam position to current camera position
      this.position.copy(this.control.camera.position)
      this.rotation.set(0, 0, 0)
      this.rotation.y = this.orbitYaw
      this.rotation.x = this.orbitPitch
    } else {
      this.mode = 'agentFocus'
      this.orbitDistance = ORBIT_DISTANCE
    }
    this.emitModeInfo()
  }

  emitModeInfo() {
    const agent = this.focusedAgentId
      ? this.world.entities.get(this.focusedAgentId)
      : null
    const info = {
      mode: this.mode,
      agentName: agent?.data?.name || null,
      agentCount: this.agentIds.length,
      agentIndex: this.agentIndex,
    }
    this.world.spectatorInfo = info
    this.world.emit('spectator-mode', info)
    // Post to parent window for external UI (e.g. Next.js header)
    try {
      if (typeof window !== 'undefined' && window.parent !== window) {
        window.parent.postMessage({ type: 'spectator-mode', ...info }, '*')
      }
    } catch (e) { /* cross-origin */ }
  }

  update(delta) {
    if (!this.active) return

    if (this.mode === 'agentFocus') {
      this.updateAgentFocus(delta)
    } else {
      this.updateFreecam(delta)
    }
  }

  updateAgentFocus(delta) {
    // Mouse orbit
    if (this.control.pointer.locked) {
      this.orbitYaw += -this.control.pointer.delta.x * POINTER_LOOK_SPEED * delta
      this.orbitPitch += -this.control.pointer.delta.y * POINTER_LOOK_SPEED * delta
      this.orbitPitch = clamp(this.orbitPitch, -85 * DEG2RAD, 85 * DEG2RAD)
    }

    // Zoom
    if (this.control.scrollDelta) {
      this.orbitDistance += -this.control.scrollDelta.value * ZOOM_SPEED * delta
      this.orbitDistance = clamp(this.orbitDistance, ORBIT_MIN_DISTANCE, ORBIT_MAX_DISTANCE)
    }

    // Get agent position
    const agent = this.focusedAgentId
      ? this.world.entities.get(this.focusedAgentId)
      : null

    if (agent && agent.base) {
      const target = v1.copy(agent.base.position)
      target.y += ORBIT_HEIGHT_OFFSET

      // Compute orbit camera position from spherical coords
      this.position.set(
        target.x + Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch) * this.orbitDistance,
        target.y + Math.sin(this.orbitPitch) * this.orbitDistance,
        target.z + Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch) * this.orbitDistance,
      )

      // Look at agent
      const lookMatrix = new THREE.Matrix4().lookAt(this.position, target, UP)
      this.quaternion.setFromRotationMatrix(lookMatrix)
    }

    this.control.camera.position.copy(this.position)
    this.control.camera.quaternion.copy(this.quaternion)
    this.control.camera.zoom = 0
  }

  updateFreecam(delta) {
    // Mouse look
    if (this.control.pointer.locked) {
      this.rotation.x += -this.control.pointer.delta.y * POINTER_LOOK_SPEED * delta
      this.rotation.y += -this.control.pointer.delta.x * POINTER_LOOK_SPEED * delta
      this.rotation.x = clamp(this.rotation.x, -89 * DEG2RAD, 89 * DEG2RAD)
    }

    // Movement (E = up, Q = down)
    const moveX = (this.control.keyD?.down ? 1 : 0) - (this.control.keyA?.down ? 1 : 0)
    const moveZ = (this.control.keyS?.down ? 1 : 0) - (this.control.keyW?.down ? 1 : 0)
    const moveY = (this.control.keyE?.down ? 1 : 0) - (this.control.keyQ?.down ? 1 : 0)

    if (moveX !== 0 || moveZ !== 0 || moveY !== 0) {
      const fast = this.control.shiftLeft?.down || this.control.shiftRight?.down
      const speed = fast ? FREECAM_FAST_SPEED : FREECAM_SPEED

      // Horizontal movement relative to camera yaw
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(UP, this.rotation.y)
      const horizontal = new THREE.Vector3(moveX, 0, moveZ).normalize().applyQuaternion(yawQuat)

      this.position.x += horizontal.x * speed * delta
      this.position.z += horizontal.z * speed * delta
      this.position.y += moveY * speed * delta
    }

    this.control.camera.position.copy(this.position)
    this.control.camera.quaternion.copy(this.quaternion)
    this.control.camera.zoom = 0
  }

  destroy() {
    if (this.control) {
      this.control.release()
      this.control = null
    }
    this.world.entities.off('added', this.onEntityAdded)
    this.world.entities.off('removed', this.onEntityRemoved)
  }
}
