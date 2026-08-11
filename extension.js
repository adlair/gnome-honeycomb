// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Adlair Cerecedo-Mendez

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const LOG_PREFIX = '[GNOME Honeycomb]';
const DEBUG = false;
const ITEM_SIZE = 96;
const ICON_SIZE = 80;
const HORIZONTAL_SPACING = 92;
const VERTICAL_SPACING = 80;
const CANVAS_ALLOCATION_TIMEOUT_MS = 1500;
const MAGNET_RADIUS = 180;
const MAGNET_MIN_SCALE = 0.78;
const MAGNET_MAX_SCALE = 1.45;
const MAGNET_REPULSION = 34;
const INTERACTION_LERP = 0.18;
const DRAG_THRESHOLD = 6;
const ROTATION_SENSITIVITY = 0.005;
const PITCH_LIMIT = 1.25;
const BACK_CUTOFF = -0.15;
const BACK_SCALE = 0.45;
const FRONT_SCALE = 1.05;
const MAGNETIC_SPHERE_SCALE = 0.40;

function hlog(message) {
    if (DEBUG)
        console.debug(`${LOG_PREFIX} ${message}`);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

class SignalTracker {
    constructor() {
        this._signals = [];
    }

    connect(obj, signal, callback) {
        if (!obj || typeof obj.connect !== 'function')
            return 0;

        try {
            const id = obj.connect(signal, callback);
            this._signals.push([obj, id]);
            return id;
        } catch (e) {
            return 0;
        }
    }

    disconnectAll() {
        for (const [obj, id] of this._signals.splice(0)) {
            try {
                if (id)
                    obj.disconnect(id);
            } catch (e) {
                // Object already destroyed or signal disconnected.
            }
        }
    }
}

class HoneycombController {
    constructor() {
        this._signals = new SignalTracker();
        this._canvasSignals = new SignalTracker();

        this._enabled = false;
        this._active = false;
        this._state = 'idle';
        this._activationGeneration = 0;

        this._appGridActor = null;
        this._appDisplay = null;
        this._appDisplayActor = null;
        this._gridHintActor = null;
        this._gridSignalActor = null;
        this._appDisplayLifecycleActor = null;
        this._canvasHostActor = null;
        this._canvasLayout = null;
        this._viewport = null;
        this._viewportRect = null;
        this._lastViewportSample = null;
        this._stableViewportSamples = 0;
        this._viewportSampleCount = 0;
        this._canvas = null;
        this._singleCanvasActive = false;
        this._honeycombIcons = [];
        this._honeycombItems = [];
        this._originalParents = new Map();
        this._stockGridState = null;
        this._pageIndicatorsActor = null;
        this._pageIndicatorsState = null;
        this._hiddenNavigationActors = new Map();
        this._stockNavigationLogged = false;
        this._gridLockedSignalIds = [];

        this._basePositions = new Map();
        this._originalTransforms = new Map();

        this._panX = 0;
        this._panY = 0;
        this._rotationYaw = 0;
        this._rotationPitch = 0;
        this._dragStartYaw = 0;
        this._dragStartPitch = 0;
        this._pointerX = null;
        this._pointerY = null;

        this._dragging = false;
        this._pressing = false;
        this._pressItem = null;
        this._suppressClick = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._interactionFrameSource = 0;

        this._pollSourceId = 0;
        this._activationSourceId = 0;
        this._canvasAllocationSourceId = 0;
        this._activationIdleIds = new Set();
        this._pollTick = 0;
        this._lastSignature = '';
        this._warnedNotFound = false;
        this._flattenDiagnosticsLogged = false;

    }

    enable() {
        if (this._enabled)
            return;

        this._enabled = true;

        this._signals.connect(Main.overview, 'showing', () => {
            this.requestActivate('overview showing');
        });

        this._signals.connect(Main.overview, 'shown', () => {
            this.requestActivate('overview shown');
            this._installAppDisplayLifecycleHook();
        });

        this._signals.connect(Main.overview, 'hidden', () => {
            hlog(`Overview hidden -> restoring generation=${this._activationGeneration + 1}`);
            this.disableHoneycombIfActive('overview hidden');
        });

        this._installAppDisplayLifecycleHook();
        this.requestActivate('enable');
        this._startPolling();
    }

    disable() {
        if (!this._enabled)
            return;

        this._enabled = false;
        this._active = false;
        this._activationGeneration++;

        this._stopPolling();
        this._clearPendingActivation();
        this._cancelCanvasAllocationWait();
        this._cancelActivationIdles();
        this._signals.disconnectAll();
        this._canvasSignals.disconnectAll();

        this._restoreCanvasState();

        if (this._appGridActor) {
            try {
                this._appGridActor.remove_style_class_name('honeycomb-active');
            } catch (e) {
                // Actor was destroyed.
            }
        }

        this._appGridActor = null;
        this._appDisplay = null;
        this._appDisplayActor = null;
        this._gridHintActor = null;
        this._gridSignalActor = null;
        this._appDisplayLifecycleActor = null;
        this._canvasHostActor = null;
        this._canvasLayout = null;
        this._viewport = null;
        this._viewportRect = null;
        this._lastViewportSample = null;
        this._stableViewportSamples = 0;
        this._viewportSampleCount = 0;
        this._canvas = null;
        this._singleCanvasActive = false;
        this._honeycombIcons = [];
        this._honeycombItems = [];
        this._basePositions.clear();
        this._originalTransforms.clear();
        this._originalParents.clear();
        this._stockGridState = null;
        this._pageIndicatorsActor = null;
        this._pageIndicatorsState = null;
        this._hiddenNavigationActors.clear();
        this._stockNavigationLogged = false;
        this._lastSignature = '';
        this._warnedNotFound = false;
        this._pollTick = 0;
        this._state = 'idle';

        this._panX = 0;
        this._panY = 0;
        this._rotationYaw = 0;
        this._rotationPitch = 0;
        this._dragStartYaw = 0;
        this._dragStartPitch = 0;
        this._pointerX = null;
        this._pointerY = null;
        this._dragging = false;
        this._pressing = false;
        this._pressItem = null;
        this._suppressClick = false;
        this._interactionFrameSource = 0;
    }

    requestActivate(reason = 'unspecified') {
        hlog(`requestActivate(${reason})`);

        if (!this._enabled)
            return;

        if (!Main.overview?.visible && reason === 'enable')
            return;

        this._installAppDisplayLifecycleHook();

        if (!Main.overview?.visible && reason === 'appDisplay mapped')
            return;

        if (this._state === 'waiting-canvas' || this._state === 'moving-icons') {
            hlog(`Activation already in progress; ignoring requestActivate(${reason})`);
            return;
        }

        if (this._state === 'active') {
            this._refreshLayout(false);
            return;
        }

        if (this._state === 'restoring') {
            hlog(`Activation restore in progress; ignoring requestActivate(${reason})`);
            return;
        }

        if (this._activationSourceId) {
            hlog(`Activation already scheduled; ignoring requestActivate(${reason})`);
            return;
        }

        const generation = ++this._activationGeneration;
        if (reason.includes('overview'))
            hlog(`Overview shown -> activation generation=${generation}`);

        this._activationSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._activationSourceId = 0;
            if (generation !== this._activationGeneration)
                return GLib.SOURCE_REMOVE;

            this._tryActivate(reason, generation);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearPendingActivation() {
        if (!this._activationSourceId)
            return;

        GLib.Source.remove(this._activationSourceId);
        this._activationSourceId = 0;
    }

    _cancelCanvasAllocationWait() {
        if (!this._canvasAllocationSourceId)
            return;

        GLib.Source.remove(this._canvasAllocationSourceId);
        this._canvasAllocationSourceId = 0;
    }

    _queueActivationIdle(callback, generation = this._activationGeneration) {
        let sourceId = 0;
        sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._activationIdleIds.delete(sourceId);

            if (generation !== this._activationGeneration)
                return GLib.SOURCE_REMOVE;

            if (!this._enabled || !this._canvas)
                return GLib.SOURCE_REMOVE;

            try {
                callback(generation);
            } catch (e) {
                hlog(`activation idle ERROR: ${e?.message ?? e}`);
                logError(e, '[GNOME Honeycomb] activation idle exception');
                this._rollbackActivation();
            }

            return GLib.SOURCE_REMOVE;
        });
        this._activationIdleIds.add(sourceId);
        return sourceId;
    }

    _cancelActivationIdles() {
        for (const sourceId of this._activationIdleIds) {
            try {
                GLib.Source.remove(sourceId);
            } catch (e) {
                // Source already ran.
            }
        }
        this._activationIdleIds.clear();
    }

    _cancelInteractionFrame() {
        if (!this._interactionFrameSource)
            return;

        GLib.Source.remove(this._interactionFrameSource);
        this._interactionFrameSource = 0;
    }

    _resetInteractionState(reason = 'unspecified') {
        if (reason === 'restore' && this._dragging)
            hlog('Drag cancelled by Overview lifecycle');

        this._cancelInteractionFrame();
        this._pointerX = null;
        this._pointerY = null;
        this._panX = 0;
        this._panY = 0;
        this._rotationYaw = 0;
        this._rotationPitch = 0;
        this._dragStartYaw = 0;
        this._dragStartPitch = 0;
        this._dragging = false;
        this._pressing = false;
        this._pressItem = null;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._suppressClick = false;

        for (const item of this._honeycombItems)
            item.suppressClick = false;

        if (reason === 'restore')
            hlog('Interaction state reset on restore: pan=0,0');
        else if (reason === 'activation')
            hlog('Interaction state initialized: pan=0,0 pointer=null dragging=false yaw=0 pitch=0');
    }

    _resetViewportGeometrySampling() {
        this._viewportRect = null;
        this._lastViewportSample = null;
        this._stableViewportSamples = 0;
        this._viewportSampleCount = 0;
    }

    _rectsClose(a, b) {
        if (!a || !b)
            return false;

        return Math.abs(a.x - b.x) <= 1 &&
            Math.abs(a.y - b.y) <= 1 &&
            Math.abs(a.width - b.width) <= 1 &&
            Math.abs(a.height - b.height) <= 1;
    }

    _sampleStableViewportGeometry() {
        const rect = this._getAppDisplayStageRect();

        if (rect.width < 50 || rect.height < 50) {
            this._lastViewportSample = rect;
            this._stableViewportSamples = 0;
            this._viewportSampleCount++;
            return false;
        }

        if (this._lastViewportSample && this._rectsClose(this._lastViewportSample, rect)) {
            this._stableViewportSamples++;
        } else {
            if (this._lastViewportSample) {
                hlog(`Viewport geometry waiting: sample1 y=${Math.round(this._lastViewportSample.y)} sample2 y=${Math.round(rect.y)}`);
            }
            this._stableViewportSamples = 1;
        }

        this._lastViewportSample = rect;
        this._viewportSampleCount++;

        if (this._stableViewportSamples >= 2 || this._viewportSampleCount >= 10) {
            this._viewportRect = {...rect};
            hlog(`Viewport geometry stable: x=${Math.round(rect.x)} y=${Math.round(rect.y)} width=${Math.round(rect.width)} height=${Math.round(rect.height)}`);
            return true;
        }

        return false;
    }

    _installAppDisplayLifecycleHook() {
        const appDisplay =
            Main.overview?._overview?.controls?._appDisplay ??
            Main.overview?.controls?._appDisplay ??
            Main.overview?._overview?._controls?._appDisplay ??
            null;

        const actor =
            appDisplay?.actor ??
            appDisplay?._view?.actor ??
            appDisplay?._view ??
            appDisplay?._views?.[0]?.actor ??
            appDisplay?._views?.[0] ??
            null;

        if (!actor || typeof actor.connect !== 'function')
            return;

        if (this._appDisplayLifecycleActor === actor)
            return;

        this._appDisplayLifecycleActor = actor;
        this._signals.connect(actor, 'notify::visible', () => {
            if (actor.visible)
                this.requestActivate('appDisplay visible');
        });
        this._signals.connect(actor, 'notify::mapped', () => {
            if (actor.mapped)
                this.requestActivate('appDisplay mapped');
        });

        if (actor.visible || actor.mapped)
            this.requestActivate('appDisplay mapped');
    }

    disableHoneycombIfActive(reason = 'unspecified') {
        if (this._state === 'idle' && !this._active && !this._canvas)
            return;

        hlog(`disableHoneycombIfActive(${reason})`);

        this._dragging = false;
        this._restoreCanvasState();

        if (this._appGridActor) {
            try {
                this._appGridActor.remove_style_class_name('honeycomb-active');
            } catch (e) {
                // Best effort only.
            }
        }

        this._active = false;
        this._appGridActor = null;
        this._appDisplay = null;
        this._appDisplayActor = null;
        this._gridHintActor = null;
        this._gridSignalActor = null;
        this._canvasHostActor = null;
        this._canvasLayout = null;
        this._basePositions.clear();
        this._originalTransforms.clear();
        this._lastSignature = '';
    }

    _startPolling() {
        if (this._pollSourceId)
            return;

        this._pollSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (!this._enabled)
                return GLib.SOURCE_REMOVE;

            this._pollTick++;

            if (!Main.overview?.visible)
                return GLib.SOURCE_CONTINUE;

            if (!this._active)
                return GLib.SOURCE_CONTINUE;

            if (this._isAppGridActive())
                this._refreshLayoutIfNeeded();

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (!this._pollSourceId)
            return;

        GLib.Source.remove(this._pollSourceId);
        this._pollSourceId = 0;
    }

    _tryActivate(reason = 'unspecified', generation = this._activationGeneration) {
        if (!this._enabled)
            return;

        if (generation !== this._activationGeneration)
            return;

        if (this._state !== 'idle') {
            hlog(`Activation skipped in state=${this._state} reason=${reason}`);
            return;
        }

        if (this._singleCanvasActive && this._canvas && this._honeycombItems.length > 0) {
            hlog(`Honeycomb already active with ${this._honeycombItems.length} items`);
            this._refreshLayout(true);
            return true;
        }

        if (this._active && this._appGridActor)
            return;

        const found = this._findAppGridActor();
        if (!found) {
            if (!this._active && !this._warnedNotFound) {
                hlog('AppGrid not found; extension did not activate.');
                this._warnedNotFound = true;
            }
            return;
        }

        this._appGridActor = found.gridActor;
        this._appDisplay = found.appDisplay;
        this._appDisplayActor = found.rootActor;
        this._gridHintActor = found.gridActor;
        this._warnedNotFound = false;

        if (!this._appDisplayActor?.mapped) {
            hlog('Activation deferred: AppDisplay root not mapped');
            return;
        }

        const rootBox = this._getActorAllocationSize(this._appDisplayActor);
        hlog(`rootActor allocation: ${Math.round(rootBox.width)}x${Math.round(rootBox.height)}`);
        this._connectGridSignals();

        try {
            this._appGridActor.add_style_class_name('honeycomb-active');
        } catch (e) {
            // Best effort only.
        }

        hlog(`Activation flow reason: ${reason}`);
        hlog(`rootActor=${this._appDisplayActor?.name ?? 'n/a'} class=${this._getStyleClassName(this._appDisplayActor)}`);
        this._resetInteractionState('activation');
        this._resetViewportGeometrySampling();
        this._state = 'waiting-canvas';
        this._startCanvasAllocationWait(generation);
        return true;
    }

    _connectGridSignals() {
        if (!this._appGridActor)
            return;

        if (this._gridSignalActor === this._appGridActor)
            return;

        this._gridSignalActor = this._appGridActor;

        this._signals.connect(this._appGridActor, 'destroy', () => {
            this._restoreCanvasState();
            this._active = false;
            this._appGridActor = null;
            this._appDisplay = null;
            this._appDisplayActor = null;
            this._gridHintActor = null;
            this._gridSignalActor = null;
            this._basePositions.clear();
            this._lastSignature = '';
        });

    }

    _findAppGridActor() {
        hlog('AppDisplay detection started');

        let appDisplay = null;
        let strategy = 'none';

        const directCandidates = [
            ['overview._overview.controls._appDisplay', Main.overview?._overview?.controls?._appDisplay],
            ['overview.controls._appDisplay', Main.overview?.controls?._appDisplay],
            ['overview._overview._controls._appDisplay', Main.overview?._overview?._controls?._appDisplay],
            ['overview.dash._appDisplay', Main.overview?.dash?._appDisplay],
        ];

        for (const [label, candidate] of directCandidates) {
            if (!candidate)
                continue;
            appDisplay = candidate;
            strategy = label;
            break;
        }

        if (!appDisplay) {
            const queue = [Main.overview];
            const visited = new Set();

            while (queue.length > 0 && !appDisplay) {
                const node = queue.shift();
                if (!node || visited.has(node))
                    continue;
                visited.add(node);

                try {
                    if (node._views !== undefined || node._grid !== undefined || node._pageManager !== undefined) {
                        appDisplay = node;
                        strategy = 'recursive-overview-scan';
                        break;
                    }
                } catch (e) {
                    // Ignore inaccessible fields.
                }

                try {
                    if (typeof node.get_children === 'function') {
                        for (const child of node.get_children())
                            queue.push(child);
                    }
                } catch (e) {
                    // Ignore actor traversal failures.
                }

                for (const key of [
                    '_overview',
                    '_controls',
                    'controls',
                    '_appDisplay',
                    'appDisplay',
                    '_view',
                    '_views',
                    '_grid',
                    '_pageManager',
                    'actor',
                    'dash',
                ]) {
                    try {
                        const maybe = node[key];
                        if (Array.isArray(maybe)) {
                            for (const item of maybe)
                                queue.push(item);
                        } else if (maybe) {
                            queue.push(maybe);
                        }
                    } catch (e) {
                        // Ignore inaccessible fields.
                    }
                }
            }

        }

        hlog(`AppDisplay candidate path chosen: ${strategy}`);
        hlog(`AppDisplay found: ${!!appDisplay}`);

        if (!appDisplay) {
            hlog('AppDisplay NOT FOUND');
            return null;
        }

        const picked = this._pickAppDisplayRootActor(appDisplay);
        const rootActor = picked?.rootActor ?? null;
        const gridHintActor = picked?.gridHintActor ?? null;

        const rootCtor = rootActor?.constructor?.name ?? 'n/a';
        const rootClass = this._getStyleClassName(rootActor);
        const rootChildren = (() => {
            try {
                return rootActor?.get_children?.().length ?? 0;
            } catch (e) {
                return 0;
            }
        })();
        const gridCtor = gridHintActor?.constructor?.name ?? 'n/a';
        const gridClass = this._getStyleClassName(gridHintActor);
        const gridChildren = (() => {
            try {
                return gridHintActor?.get_children?.().length ?? 0;
            } catch (e) {
                return 0;
            }
        })();

        hlog(`Root pick: ${picked?.reason ?? 'none'}`);
        hlog(`RootActor=${rootCtor} class=${rootClass} children=${rootChildren}`);
        hlog(`GridHint=${gridCtor} class=${gridClass} children=${gridChildren}`);

        if (!rootActor) {
            hlog('AppDisplay NOT FOUND');
            return null;
        }

        return {
            gridActor: gridHintActor ?? rootActor,
            appDisplay,
            rootActor,
        };
    }

    _pickAppDisplayRootActor(appDisplay) {
        const isValidActor = actor => !!actor &&
            typeof actor.get_children === 'function' &&
            typeof actor.connect === 'function';

        const picks = [
            {reason: 'appDisplay._views[0]._grid', root: appDisplay?._views?.[0]?._grid, gridHint: appDisplay?._views?.[0]?._grid},
            {reason: 'appDisplay._views[0].actor', root: appDisplay?._views?.[0]?.actor, gridHint: appDisplay?._views?.[0]?._grid ?? appDisplay?._views?.[0]?.actor},
            {reason: 'appDisplay._views[0]', root: appDisplay?._views?.[0], gridHint: appDisplay?._views?.[0]?._grid ?? appDisplay?._views?.[0]},
            {reason: 'appDisplay._view._grid', root: appDisplay?._view?._grid, gridHint: appDisplay?._view?._grid},
            {reason: 'appDisplay._view.actor', root: appDisplay?._view?.actor, gridHint: appDisplay?._view?._grid ?? appDisplay?._view?.actor},
            {reason: 'appDisplay._view', root: appDisplay?._view, gridHint: appDisplay?._view?._grid ?? appDisplay?._view},
            {reason: 'appDisplay._grid', root: appDisplay?._grid, gridHint: appDisplay?._grid},
            {reason: 'appDisplay.actor', root: appDisplay?.actor, gridHint: appDisplay?._grid ?? appDisplay?.actor},
            {reason: 'appDisplay', root: appDisplay, gridHint: appDisplay?._grid ?? appDisplay},
        ];

        for (const pick of picks) {
            try {
                if (isValidActor(pick.root)) {
                    const gridHintActor = isValidActor(pick.gridHint) ? pick.gridHint : pick.root;
                    return {
                        rootActor: pick.root,
                        gridHintActor,
                        reason: pick.reason,
                    };
                }
            } catch (e) {
                // Continue to next candidate safely.
            }
        }

        return {
            rootActor: null,
            gridHintActor: null,
            reason: 'none',
        };
    }

    _getActorAllocationSize(actor) {
        if (!actor)
            return {width: 0, height: 0};

        try {
            const box = actor.get_allocation_box?.();
            if (box)
                return {width: Math.max(0, box.x2 - box.x1), height: Math.max(0, box.y2 - box.y1)};
        } catch (e) {
            // Fallback below.
        }

        try {
            const width = actor.width ?? 0;
            const height = actor.height ?? 0;
            if (width > 0 || height > 0)
                return {width: Math.max(0, width), height: Math.max(0, height)};
        } catch (e) {
            // Fallback below.
        }

        try {
            const [width, height] = actor.get_size?.() ?? [0, 0];
            return {width: Math.max(0, width), height: Math.max(0, height)};
        } catch (e) {
            return {width: 0, height: 0};
        }
    }

    _hasValidAllocation(actor) {
        const {width, height} = this._getActorAllocationSize(actor);
        return width > 50 && height > 50;
    }

    _getActorSize(actor) {
        try {
            const box = actor.get_allocation_box();
            const width = Math.max(0, box.x2 - box.x1);
            const height = Math.max(0, box.y2 - box.y1);

            if (width > 0 && height > 0)
                return {width, height};
        } catch (e) {
            // Fall back to explicit actor dimensions.
        }

        const width = Number(actor?.width ?? 0);
        const height = Number(actor?.height ?? 0);
        return {width, height};
    }

    _getTransformedActorSize(actor) {
        try {
            const [width, height] = actor.get_transformed_size?.() ?? [0, 0];
            if (width > 0 || height > 0)
                return {width: Math.max(0, width), height: Math.max(0, height)};
        } catch (e) {
            // Fallback below.
        }

        return this._getActorSize(actor);
    }

    _getTransformedActorPosition(actor) {
        try {
            const [x, y] = actor.get_transformed_position?.() ?? [0, 0];
            return {x, y};
        } catch (e) {
            return {x: Number(actor?.x ?? 0), y: Number(actor?.y ?? 0)};
        }
    }

    _getAppDisplayStageRect() {
        const pos = this._getTransformedActorPosition(this._appDisplayActor);
        const size = this._getTransformedActorSize(this._appDisplayActor);
        return {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        };
    }

    _getLayoutManagerName(actor) {
        try {
            const layout = actor.get_layout_manager?.() ?? actor.layout_manager;
            return layout?.constructor?.name ?? 'none';
        } catch (e) {
            return 'none';
        }
    }

    _isIconActor(actor) {
        if (!actor)
            return false;

        if (AppDisplay?.AppIcon && actor instanceof AppDisplay.AppIcon)
            return true;

        if (actor.app && actor.icon)
            return true;

        const cname = actor.constructor?.name ?? '';
        if (cname.includes('AppIcon') || cname.includes('AppViewItem'))
            return true;

        return false;
    }

    _getStyleClassName(actor) {
        if (!actor)
            return '';

        try {
            if (typeof actor.get_style_class_name === 'function')
                return actor.get_style_class_name() ?? '';
        } catch (e) {
            // Not an St widget.
        }

        try {
            if (actor.style_class)
                return actor.style_class;
        } catch (e) {
            // Property unavailable.
        }

        return '';
    }

    _isFolderPopupActor(actor) {
        const style = this._getStyleClassName(actor).toLowerCase();
        const name = `${actor?.name ?? ''}`.toLowerCase();
        return style.includes('folder-popup') ||
            style.includes('app-folder-dialog') ||
            name.includes('folder-popup') ||
            name.includes('app-folder-dialog');
    }

    _isSearchResultsActor(actor) {
        const style = this._getStyleClassName(actor).toLowerCase();
        const name = `${actor?.name ?? ''}`.toLowerCase();
        return style.includes('search-results') ||
            style.includes('search-section') ||
            style.includes('search-provider') ||
            name.includes('search-results');
    }

    _isAppTileActor(actor) {
        if (!actor)
            return false;

        if (actor === this._canvas || actor.name === 'honeycombCanvas')
            return false;

        if (this._isIconActor(actor))
            return true;

        const style = this._getStyleClassName(actor).toLowerCase();
        const cname = `${actor.constructor?.name ?? ''}`.toLowerCase();
        const reactive = !!actor.reactive;
        const looksLikeTileStyle = style.includes('overview-icon') || style.includes('app-well-app');
        const looksLikeTileClass = cname.includes('appicon') || cname.includes('appviewitem');

        if (!reactive && !looksLikeTileClass && !looksLikeTileStyle)
            return false;

        if (looksLikeTileStyle || looksLikeTileClass)
            return true;

        if (actor.app && actor.icon)
            return true;

        return false;
    }

    _ensureCanvas() {
        if (!this._appDisplayActor)
            return false;

        const rect = this._viewportRect;
        if (!rect) {
            hlog('Viewport creation deferred: stable viewport rect not ready');
            return false;
        }

        if (rect.width < 50 || rect.height < 50) {
            hlog(`Viewport creation deferred: appDisplay stage size ${Math.round(rect.width)}x${Math.round(rect.height)}`);
            return false;
        }

        this._cleanupOrphanCanvases();

        if (this._viewport && this._canvas && this._viewport.get_parent() && this._canvas.get_parent()) {
            this._viewport.set_position(rect.x, rect.y);
            this._viewport.set_size(rect.width, rect.height);
            this._canvas.set_position(0, 0);
            this._canvas.set_size(rect.width, rect.height);
            hlog(`Honeycomb viewport rect: x=${Math.round(rect.x)} y=${Math.round(rect.y)} width=${Math.round(rect.width)} height=${Math.round(rect.height)}`);
            hlog(`Viewport local size: ${Math.round(this._viewport.width)}x${Math.round(this._viewport.height)}`);
            hlog(`Canvas properties after creation: ${this._canvas.width}x${this._canvas.height}`);
            return true;
        }

        if (this._canvas && !this._canvas.get_parent()) {
            try {
                this._canvas.destroy();
            } catch (e) {
                // Already destroyed.
            }
            this._canvas = null;
        }

        if (this._viewport && !this._viewport.get_parent()) {
            try {
                this._viewport.destroy();
            } catch (e) {
                // Already destroyed.
            }
            this._viewport = null;
        }

        let viewport = null;
        let canvas = null;
        try {
            hlog(`AppDisplay transformed rect: x=${Math.round(rect.x)} y=${Math.round(rect.y)} width=${Math.round(rect.width)} height=${Math.round(rect.height)}`);
            viewport = new St.Widget({
                name: 'honeycombViewport',
                reactive: true,
                visible: true,
                opacity: 255,
                clip_to_allocation: true,
                layout_manager: new Clutter.FixedLayout(),
            });
            viewport.set_position(rect.x, rect.y);
            viewport.set_size(rect.width, rect.height);

            const layout = new Clutter.FixedLayout();
            canvas = new Clutter.Actor({
                name: 'honeycombCanvas',
                reactive: true,
                visible: true,
                opacity: 255,
                x_expand: true,
                y_expand: true,
                clip_to_allocation: false,
                layout_manager: layout,
            });
            canvas.set_position(0, 0);
            canvas.set_size(rect.width, rect.height);

            this._canvasHostActor = Main.uiGroup;
            this._canvasLayout = layout;
            this._viewport = viewport;
            this._canvas = canvas;
            Main.uiGroup.add_child(this._viewport);
            this._viewport.add_child(this._canvas);

            try {
                Main.uiGroup.set_child_above_sibling(this._viewport, null);
            } catch (e) {
                try {
                    this._viewport.raise_top?.();
                } catch (e2) {
                    // Best effort stacking.
                }
            }
            this._viewport.queue_relayout?.();
            this._canvas.queue_relayout?.();

            this._canvasSignals.connect(this._viewport, 'motion-event', (actor, event) => {
                return this._onHoneycombMotion(event);
            });
            this._canvasSignals.connect(this._viewport, 'leave-event', () => {
                return this._onHoneycombLeave();
            });
            this._canvasSignals.connect(this._viewport, 'button-press-event', (actor, event) => {
                return this._onHoneycombButtonPress(event, null);
            });
            this._canvasSignals.connect(this._viewport, 'button-release-event', (actor, event) => {
                return this._onHoneycombButtonRelease(event);
            });
            this._canvasSignals.connect(this._canvas, 'motion-event', (actor, event) => {
                return this._onHoneycombMotion(event);
            });
            this._canvasSignals.connect(this._canvas, 'button-press-event', (actor, event) => {
                return this._onHoneycombButtonPress(event, null);
            });
            this._canvasSignals.connect(this._canvas, 'button-release-event', (actor, event) => {
                return this._onHoneycombButtonRelease(event);
            });

            hlog(`Canvas host: Main.uiGroup layout=${this._getLayoutManagerName(Main.uiGroup)}`);
            hlog(`Viewport stage rect: ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
            hlog(`Honeycomb viewport rect: x=${Math.round(rect.x)} y=${Math.round(rect.y)} width=${Math.round(rect.width)} height=${Math.round(rect.height)}`);
            hlog(`Viewport local size: ${Math.round(this._viewport.width)}x${Math.round(this._viewport.height)}`);
            hlog(`Canvas requested size: ${Math.round(rect.width)}x${Math.round(rect.height)}`);
            hlog(`Canvas properties after creation: ${this._canvas.width}x${this._canvas.height}`);
            hlog('Honeycomb initial pan: 0,0');
            return true;
        } catch (e) {
            hlog(`Failed to create viewport/canvas: ${e.message}`);
            if (canvas) {
                try {
                    canvas.destroy();
                } catch (e2) {
                    // Already detached or destroyed.
                }
            }
            if (viewport) {
                try {
                    viewport.destroy();
                } catch (e2) {
                    // Already detached or destroyed.
                }
            }
            this._viewport = null;
            this._canvas = null;
            return false;
        }
    }

    _cleanupOrphanCanvases() {
        const host = Main.uiGroup ?? this._canvasHostActor ?? this._appDisplayActor;
        if (!host?.get_children)
            return;

        for (const child of host.get_children()) {
            if (child === this._canvas || child === this._viewport)
                continue;

            try {
                if (child.name === 'honeycombCanvas' || child.name === 'honeycombViewport') {
                    hlog(`Removing orphan ${child.name}`);
                    child.destroy();
                }
            } catch (e) {
                // Ignore actors that disappear during traversal.
            }
        }
    }

    _collectAllIconTiles() {
        if (!this._appDisplayActor || this._isSearchActive())
            return [];

        let rootChildrenCount = 0;
        try {
            rootChildrenCount = this._appDisplayActor.get_children?.().length ?? 0;
        } catch (e) {
            rootChildrenCount = 0;
        }
        hlog(`Collect BFS root children: ${rootChildrenCount}`);

        const result = [];
        const seen = new Set();
        const queue = [this._appDisplayActor];

        while (queue.length > 0) {
            const node = queue.shift();
            if (!node || seen.has(node))
                continue;
            seen.add(node);

            if (node === this._canvas || node.name === 'honeycombCanvas')
                continue;

            if (node !== this._appDisplayActor && this._isFolderPopupActor(node))
                continue;
            if (node !== this._appDisplayActor && this._isSearchResultsActor(node))
                continue;

            if (this._isAppTileActor(node)) {
                result.push(node);
                continue;
            }

            if (typeof node.get_children === 'function') {
                for (const child of node.get_children())
                    queue.push(child);
            }
        }

        if (result.length === 0 && !this._singleCanvasActive)
            hlog('Collected icon tiles: 0 (rootActor might be wrong)');

        return result;
    }

    _resolveAppFromActor(actor) {
        const candidates = [
            actor?.app,
            actor?._app,
            actor?._delegate?.app,
            actor?._delegate?._app,
        ];

        for (const app of candidates) {
            try {
                if (app && typeof app.create_icon_texture === 'function' && typeof app.activate === 'function')
                    return app;
            } catch (e) {
                // Continue probing private GNOME fields defensively.
            }
        }

        return null;
    }

    _getAppId(app) {
        try {
            return app?.get_id?.() ?? '';
        } catch (e) {
            return '';
        }
    }

    _getAppName(app) {
        try {
            return app?.get_name?.() ?? this._getAppId(app);
        } catch (e) {
            return this._getAppId(app);
        }
    }

    _evaluateAppInfoVisibility(appInfo) {
        const result = {
            appId: '',
            appName: '',
            infoType: `${appInfo?.constructor?.name ?? 'null'}`,
            hasShouldShow: false,
            shouldShow: 'n-a',
            keep: false,
            reason: 'unknown',
            filterError: false,
        };

        if (!appInfo) {
            result.reason = 'no-info';
            return result;
        }

        try {
            result.appId = appInfo.get_id?.() ?? '';
        } catch (e) {
            result.appId = '';
        }

        try {
            result.appName = appInfo.get_name?.() ?? result.appId;
        } catch (e) {
            result.appName = result.appId;
        }

        if (!result.appId) {
            result.reason = 'no-id';
            return result;
        }

        result.hasShouldShow = typeof appInfo.should_show === 'function';
        if (result.hasShouldShow) {
            try {
                const shouldShow = appInfo.should_show();
                result.shouldShow = `${shouldShow}`;
                if (shouldShow === false) {
                    result.reason = 'hidden-by-should-show';
                    result.keep = false;
                } else {
                    result.reason = 'should-show-keep';
                    result.keep = true;
                }
            } catch (e) {
                result.filterError = true;
                result.shouldShow = 'error';
                result.reason = 'should-show-error-keep';
                result.keep = true;
            }
        } else {
            result.reason = 'no-should-show-api-keep';
            result.keep = true;
        }

        return result;
    }

    _getAppSystem() {
        let appSystem = null;
        try {
            appSystem = Shell.AppSystem.get_default();
        } catch (e) {
            hlog(`Shell.AppSystem unavailable: ${e?.message ?? e}`);
        }

        return appSystem;
    }

    _getInstalledAppInfos(appSystem) {
        if (!appSystem)
            return [];

        const methods = [
            'get_installed',
            'get_all',
            'get_apps',
        ];

        for (const method of methods) {
            try {
                if (typeof appSystem?.[method] !== 'function')
                    continue;

                const apps = appSystem[method]();
                if (Array.isArray(apps))
                    return apps;
                if (apps && typeof apps[Symbol.iterator] === 'function')
                    return Array.from(apps);
            } catch (e) {
                hlog(`Shell.AppSystem.${method} failed: ${e?.message ?? e}`);
            }
        }

        return [];
    }

    _lookupShellApp(appSystem, appId) {
        try {
            return appSystem?.lookup_app?.(appId) ?? null;
        } catch (e) {
            hlog(`Shell.App resolution failed: ${appId}`);
            return null;
        }
    }

    _isValidShellApp(app) {
        return !!app &&
            typeof app.get_id === 'function' &&
            typeof app.get_name === 'function' &&
            typeof app.activate === 'function' &&
            typeof app.create_icon_texture === 'function';
    }

    _discoverHoneycombApplications(appGridTiles = []) {
        const appSystem = this._getAppSystem();
        const rawInfos = this._getInstalledAppInfos(appSystem);
        const unique = new Map();
        const counters = {
            rawInfo: rawInfos.length,
            noId: 0,
            hidden: 0,
            lookupFailed: 0,
            resolved: 0,
        };
        let resolutionDiagnostics = 0;

        for (const appInfo of rawInfos) {
            const evaluation = this._evaluateAppInfoVisibility(appInfo);

            if (!evaluation.appId)
                counters.noId++;
            if (evaluation.reason === 'hidden-by-should-show')
                counters.hidden++;
            if (!evaluation.keep)
                continue;

            const shellApp = this._lookupShellApp(appSystem, evaluation.appId);
            if (!shellApp) {
                counters.lookupFailed++;
                hlog(`Shell.App resolution failed: ${evaluation.appId}`);
                continue;
            }

            const shellAppId = this._getAppId(shellApp);
            const validShellApp = this._isValidShellApp(shellApp);
            if (resolutionDiagnostics < 5) {
                hlog(`Application resolution: infoType=${evaluation.infoType} id="${evaluation.appId}" shellType=${shellApp?.constructor?.name ?? 'null'} shellId="${shellAppId}" hasCreateIconTexture=${typeof shellApp?.create_icon_texture === 'function'} hasActivate=${typeof shellApp?.activate === 'function'}`);
                resolutionDiagnostics++;
            }

            if (!validShellApp) {
                counters.lookupFailed++;
                hlog(`Shell.App resolution failed: ${evaluation.appId}`);
                continue;
            }

            counters.resolved++;
            if (!unique.has(shellAppId))
                unique.set(shellAppId, shellApp);
        }

        const apps = Array.from(unique.values());
        apps.sort((a, b) => {
            const nameA = this._getAppName(a);
            const nameB = this._getAppName(b);
            const byName = nameA.localeCompare(nameB);
            if (byName !== 0)
                return byName;
            return this._getAppId(a).localeCompare(this._getAppId(b));
        });

        hlog(`Honeycomb application universe: rawInfo=${counters.rawInfo} hidden=${counters.hidden} noId=${counters.noId} lookupFailed=${counters.lookupFailed} resolved=${counters.resolved} unique=${apps.length}`);

        const tileAppIds = new Set();
        for (const tile of appGridTiles) {
            const app = this._resolveAppFromActor(tile);
            const appId = this._getAppId(app);
            if (appId)
                tileAppIds.add(appId);
        }

        hlog(`AppGrid tiles: ${appGridTiles.length}`);
        hlog(`Honeycomb direct apps: ${apps.length}`);

        if (!this._flattenDiagnosticsLogged) {
            let logged = 0;
            for (const app of apps) {
                const appId = this._getAppId(app);
                if (!appId || tileAppIds.has(appId))
                    continue;

                hlog(`Flattened app added: ${appId} "${this._getAppName(app)}"`);
                logged++;
                if (logged >= 20)
                    break;
            }
            this._flattenDiagnosticsLogged = true;
        }

        return apps;
    }

    _forceFixedActorSize(actor, width, height) {
        if (!actor)
            return;

        try {
            actor.set_size?.(width, height);
            actor.set_width?.(width);
            actor.set_height?.(height);
            actor.x_expand = false;
            actor.y_expand = false;
        } catch (e) {
            // Some actor properties are version/theme dependent.
        }
    }

    _createHoneycombVisualActor(app) {
        const button = new St.Button({
            style_class: 'honeycomb-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._forceFixedActorSize(button, ITEM_SIZE, ITEM_SIZE);
        button.set_pivot_point?.(0, 0);

        const iconBin = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._forceFixedActorSize(iconBin, ICON_SIZE, ICON_SIZE);
        try {
            iconBin.set_clip_to_allocation?.(true);
        } catch (e) {
            // Optional API.
        }

        const icon = app.create_icon_texture(ICON_SIZE);
        this._forceFixedActorSize(icon, ICON_SIZE, ICON_SIZE);

        iconBin.set_child(icon);
        button.set_child(iconBin);

        return {visualActor: button, iconActor: icon, iconBin};
    }

    _createHoneycombItems(apps) {
        if (!this._canvas)
            return [];

        const items = [];
        let itemCreationFailures = 0;

        for (const app of apps) {
            const appId = this._getAppId(app);
            if (!appId)
                continue;

            if (typeof app.create_icon_texture !== 'function') {
                itemCreationFailures++;
                if (itemCreationFailures <= 5)
                    hlog(`VISUAL ITEM REJECTED: not Shell.App id=${appId}`);
                continue;
            }

            try {
                const itemIndex = items.length;
                const visual = this._createHoneycombVisualActor(app);
                const {visualActor, iconActor, iconBin} = visual;
                this._canvas.add_child(visualActor);
                visualActor.visible = true;
                visualActor.opacity = 255;
                this._forceFixedActorSize(visualActor, ITEM_SIZE, ITEM_SIZE);
                this._forceFixedActorSize(iconBin, ICON_SIZE, ICON_SIZE);
                this._forceFixedActorSize(iconActor, ICON_SIZE, ICON_SIZE);
                visualActor.queue_relayout?.();
                if (itemIndex < 5) {
                    hlog(`Item[${itemIndex}] requested=${ITEM_SIZE}x${ITEM_SIZE} actor=${visualActor.width}x${visualActor.height}`);
                    hlog(`Icon[${itemIndex}] requested=${ICON_SIZE}x${ICON_SIZE} actor=${iconActor.width}x${iconActor.height}`);
                }
                const item = {
                    originalActor: null,
                    app,
                    appId,
                    visualActor,
                    iconActor,
                    iconBin,
                    baseX: 0,
                    baseY: 0,
                    sphereX: 0,
                    sphereY: 0,
                    sphereZ: 1,
                    theta: 0,
                    phi: 0,
                    rz: 1,
                    currentX: 0,
                    currentY: 0,
                    currentScale: 1,
                    currentOpacity: 255,
                    targetX: 0,
                    targetY: 0,
                    targetScale: 1,
                    targetOpacity: 255,
                    suppressClick: false,
                };
                this._connectHoneycombItemSignals(item);
                items.push(item);
            } catch (e) {
                itemCreationFailures++;
                if (itemCreationFailures <= 5)
                    hlog(`Failed to create honeycomb visual item: id=${appId} type=${app?.constructor?.name ?? 'unknown'} error=${e?.message ?? e}`);
            }
        }

        hlog(`Honeycomb item creation: requested=${apps.length} created=${items.length} failed=${itemCreationFailures}`);
        return items;
    }

    _destroyHoneycombVisualItems() {
        for (const item of this._honeycombItems.splice(0)) {
            try {
                item.visualActor?.destroy?.();
            } catch (e) {
                // Actor already gone.
            }
        }
        this._honeycombIcons = [];
    }

    _connectHoneycombItemSignals(item) {
        const actor = item.visualActor;
        this._canvasSignals.connect(actor, 'button-press-event', (_actor, event) => {
            return this._onHoneycombButtonPress(event, item);
        });
        this._canvasSignals.connect(actor, 'button-release-event', (_actor, event) => {
            return this._onHoneycombButtonRelease(event);
        });
        this._canvasSignals.connect(actor, 'motion-event', (_actor, event) => {
            return this._onHoneycombMotion(event);
        });
        this._canvasSignals.connect(actor, 'clicked', () => {
            if (item.suppressClick) {
                item.suppressClick = false;
                return;
            }

            try {
                item.app.activate();
                Main.overview?.hide?.();
            } catch (e) {
                hlog(`Failed to activate app from honeycomb item: ${e?.message ?? e}`);
            }
        });
    }

    _eventToViewportCoords(event) {
        const [stageX, stageY] = event.get_coords();
        try {
            const [ok, localX, localY] = this._viewport.transform_stage_point(stageX, stageY);
            if (ok)
                return {x: localX, y: localY};
        } catch (e) {
            // Fallback below.
        }

        const pos = this._getTransformedActorPosition(this._viewport);
        return {x: stageX - pos.x, y: stageY - pos.y};
    }

    _scheduleInteractionFrame() {
        if (this._interactionFrameSource || !this._active)
            return;

        this._interactionFrameSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            this._interactionFrameSource = 0;
            if (!this._active || !this._canvas || this._honeycombItems.length === 0)
                return GLib.SOURCE_REMOVE;

            const keepGoing = this._runInteractionFrame();
            if (keepGoing)
                this._scheduleInteractionFrame();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onHoneycombMotion(event) {
        if (!this._active || !this._viewport)
            return Clutter.EVENT_PROPAGATE;

        const {x, y} = this._eventToViewportCoords(event);
        this._pointerX = x;
        this._pointerY = y;

        if (this._pressing) {
            const dx = x - this._dragStartX;
            const dy = y - this._dragStartY;
            if (!this._dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
                this._dragging = true;
                if (this._pressItem)
                    this._pressItem.suppressClick = true;
                hlog(`Sphere drag started: yaw=${this._rotationYaw.toFixed(3)} pitch=${this._rotationPitch.toFixed(3)}`);
            }

            if (this._dragging) {
                this._panX = 0;
                this._panY = 0;
                this._rotationYaw = this._normalizeYaw(this._dragStartYaw + dx * ROTATION_SENSITIVITY);
                this._rotationPitch = clamp(this._dragStartPitch - dy * ROTATION_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT);
            }
        }

        this._scheduleInteractionFrame();
        return this._dragging ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _onHoneycombLeave() {
        if (!this._active)
            return Clutter.EVENT_PROPAGATE;

        if (!this._dragging) {
            this._pointerX = null;
            this._pointerY = null;
            this._scheduleInteractionFrame();
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onHoneycombButtonPress(event, item = null) {
        if (!this._active || !this._viewport)
            return Clutter.EVENT_PROPAGATE;

        if (event.get_button?.() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        if (this._pressing && !item)
            return Clutter.EVENT_PROPAGATE;

        if (item)
            item.suppressClick = false;

        const {x, y} = this._eventToViewportCoords(event);
        this._pointerX = x;
        this._pointerY = y;
        this._pressing = true;
        this._pressItem = item;
        this._dragging = false;
        this._dragStartX = x;
        this._dragStartY = y;
        this._dragStartYaw = this._rotationYaw;
        this._dragStartPitch = this._rotationPitch;
        this._scheduleInteractionFrame();
        return Clutter.EVENT_PROPAGATE;
    }

    _onHoneycombButtonRelease(event) {
        if (!this._active)
            return Clutter.EVENT_PROPAGATE;

        const wasDragging = this._dragging;
        if (event) {
            const {x, y} = this._eventToViewportCoords(event);
            this._pointerX = x;
            this._pointerY = y;
        }

        this._pressing = false;
        const pressedItem = this._pressItem;
        this._dragging = false;
        this._pressItem = null;
        this._scheduleInteractionFrame();

        if (wasDragging) {
            this._panX = 0;
            this._panY = 0;
            hlog(`Sphere drag ended: yaw=${this._rotationYaw.toFixed(3)} pitch=${this._rotationPitch.toFixed(3)}`);
            if (pressedItem)
                pressedItem.suppressClick = true;
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _rollbackActivation() {
        hlog('Activation failed -> rolling back icons to original parents');
        this._restoreCanvasState();
    }

    _startCanvasAllocationWait(generation) {
        this._cancelCanvasAllocationWait();

        const startedAt = GLib.get_monotonic_time();
        this._canvasAllocationSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
            if (generation !== this._activationGeneration) {
                this._canvasAllocationSourceId = 0;
                return GLib.SOURCE_REMOVE;
            }

            if (!this._enabled || this._state !== 'waiting-canvas') {
                this._canvasAllocationSourceId = 0;
                return GLib.SOURCE_REMOVE;
            }

            if (!this._hasValidAllocation(this._appDisplayActor)) {
                const elapsedMs = (GLib.get_monotonic_time() - startedAt) / 1000;
                if (elapsedMs >= CANVAS_ALLOCATION_TIMEOUT_MS) {
                    this._canvasAllocationSourceId = 0;
                    hlog('Canvas allocation timeout');
                    this._rollbackActivation();
                    return GLib.SOURCE_REMOVE;
                }

                hlog('Activation deferred: rootActor allocation not ready');
                return GLib.SOURCE_CONTINUE;
            }

            if (!this._viewportRect && !this._sampleStableViewportGeometry()) {
                const elapsedMs = (GLib.get_monotonic_time() - startedAt) / 1000;
                if (elapsedMs >= CANVAS_ALLOCATION_TIMEOUT_MS) {
                    this._canvasAllocationSourceId = 0;
                    hlog('Canvas allocation timeout');
                    this._rollbackActivation();
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            }

            if (!this._canvas && !this._ensureCanvas()) {
                const elapsedMs = (GLib.get_monotonic_time() - startedAt) / 1000;
                if (elapsedMs >= CANVAS_ALLOCATION_TIMEOUT_MS) {
                    this._canvasAllocationSourceId = 0;
                    hlog('Canvas allocation timeout');
                    this._rollbackActivation();
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            }

            const canvasSize = this._getActorSize(this._canvas);
            const canvasReady = this._canvas?.has_allocation?.() || (canvasSize.width > 50 && canvasSize.height > 50);
            if (!canvasReady) {
                const elapsedMs = (GLib.get_monotonic_time() - startedAt) / 1000;
                if (elapsedMs >= CANVAS_ALLOCATION_TIMEOUT_MS) {
                    this._canvasAllocationSourceId = 0;
                    hlog('Canvas allocation timeout');
                    this._rollbackActivation();
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            }

            this._canvasAllocationSourceId = 0;
            const {width, height} = canvasSize;
            hlog(`Canvas allocated: ${Math.round(width)}x${Math.round(height)}`);
            this._moveIconsStage(generation);
            return GLib.SOURCE_REMOVE;
        });
    }

    _moveIconsStage(generation) {
        if (generation !== this._activationGeneration)
            return;

        if (this._state !== 'waiting-canvas') {
            hlog(`MOVE ABORT: invalid state=${this._state}`);
            return;
        }

        this._state = 'moving-icons';
        this._resetInteractionState('activation-silent');

        const appGridTiles = this._collectAllIconTiles();
        hlog(`Collected icon tiles: ${appGridTiles.length}`);

        const apps = this._discoverHoneycombApplications(appGridTiles);
        if (apps.length === 0) {
            hlog('No launchable applications found; cannot build single canvas.');
            this._rollbackActivation();
            return;
        }

        const items = this._createHoneycombItems(apps);
        this._honeycombItems = items;
        this._honeycombIcons = items.map(item => item.visualActor);
        hlog(`Created honeycomb visual items: ${items.length}`);
        if (items.length === 0) {
            this._rollbackActivation();
            return;
        }

        this._singleCanvasActive = true;
        this._hideStockGrid();
        this._hidePaginationUI();
        hlog(`Single-canvas mode ready with ${this._honeycombItems.length} items.`);
        hlog(`Magnetic interaction enabled: items=${this._honeycombItems.length}`);
        hlog(`Magnet parameters: radius=${MAGNET_RADIUS} scale=${MAGNET_MIN_SCALE}..${MAGNET_MAX_SCALE} repulsion=${MAGNET_REPULSION}`);
        this._scheduleInitialLayoutAfterMove(generation);
    }

    _scheduleInitialLayoutAfterMove(generation) {
        this._queueActivationIdle(() => {
            if (generation !== this._activationGeneration) {
                hlog('LAYOUT ABORT: stale generation');
                return;
            }

            if (this._state !== 'moving-icons') {
                hlog(`LAYOUT ABORT: invalid state=${this._state}`);
                return;
            }

            if (!this._canvas) {
                hlog('LAYOUT ABORT: canvas missing');
                this._rollbackActivation();
                return;
            }

            if (!this._canvas.get_parent?.()) {
                hlog('LAYOUT ABORT: canvas parent missing');
                this._rollbackActivation();
                return;
            }

            if (this._honeycombItems.length === 0) {
                hlog('LAYOUT ABORT: honeycombItems empty');
                this._rollbackActivation();
                return;
            }

            const firstItem = this._honeycombItems[0]?.visualActor;
            hlog(`First honeycomb item visible=${firstItem?.visible ?? false} mapped=${firstItem?.mapped ?? false}`);
            hlog(`Applying initial honeycomb layout to ${this._honeycombItems.length} items`);
            this._state = 'active';
            this._active = true;
            if (!this._refreshLayout(true)) {
                this._rollbackActivation();
                return;
            }

            hlog(`Honeycomb ACTIVE generation=${generation} items=${this._honeycombItems.length}`);
        }, generation);
    }

    _getPageIndicatorsFast() {
        const candidates = [
            this._appDisplay?._pageIndicators?.actor,
            this._appDisplay?._pageIndicators?._container,
            this._appDisplay?._pageIndicators,
        ];

        for (const actor of candidates) {
            if (actor && typeof actor.get_children === 'function')
                return actor;
        }

        return null;
    }

    _hideActorForRestore(actor) {
        if (!actor || this._hiddenNavigationActors.has(actor))
            return;

        try {
            this._hiddenNavigationActors.set(actor, {
                visible: actor.visible,
                opacity: actor.opacity,
                reactive: actor.reactive,
            });
            actor.opacity = 0;
            if ('reactive' in actor)
                actor.reactive = false;
            actor.hide?.();
        } catch (e) {
            hlog(`Failed to hide navigation actor: ${e?.message ?? e}`);
        }
    }

    _getActorDebugText(actor) {
        const style = this._getStyleClassName(actor).toLowerCase();
        const name = `${actor?.name ?? ''}`.toLowerCase();
        const ctor = `${actor?.constructor?.name ?? ''}`.toLowerCase();
        return `${style} ${name} ${ctor}`;
    }

    _addNavigationCandidate(nav, kind, actor) {
        if (!actor || typeof actor !== 'object')
            return;

        try {
            if (actor === this._canvas || actor === this._viewport)
                return;
            if (typeof actor.get_parent !== 'function' && typeof actor.hide !== 'function' && typeof actor.get_children !== 'function')
                return;
        } catch (e) {
            return;
        }

        if (!nav[kind].includes(actor))
            nav[kind].push(actor);
    }

    _discoverStockNavigationActors() {
        const nav = {
            leftArrow: [],
            rightArrow: [],
            pageIndicators: [],
        };

        const fastCandidates = [
            ['leftArrow', this._appDisplay?._prevPageArrow],
            ['leftArrow', this._appDisplay?._previousPageArrow],
            ['leftArrow', this._appDisplay?._prevPageButton],
            ['leftArrow', this._appDisplay?._previousPageButton],
            ['leftArrow', this._appDisplay?._view?._prevPageArrow],
            ['leftArrow', this._appDisplay?._view?._previousPageArrow],
            ['leftArrow', this._appDisplay?._views?.[0]?._prevPageArrow],
            ['leftArrow', this._appDisplay?._views?.[0]?._previousPageArrow],
            ['rightArrow', this._appDisplay?._nextPageArrow],
            ['rightArrow', this._appDisplay?._nextPageButton],
            ['rightArrow', this._appDisplay?._view?._nextPageArrow],
            ['rightArrow', this._appDisplay?._view?._nextPageButton],
            ['rightArrow', this._appDisplay?._views?.[0]?._nextPageArrow],
            ['rightArrow', this._appDisplay?._views?.[0]?._nextPageButton],
            ['pageIndicators', this._getPageIndicatorsFast()],
            ['pageIndicators', this._appDisplay?._view?._pageIndicators],
            ['pageIndicators', this._appDisplay?._views?.[0]?._pageIndicators],
        ];

        for (const [kind, actor] of fastCandidates)
            this._addNavigationCandidate(nav, kind, actor?.actor ?? actor);

        const roots = [
            this._appDisplayActor,
            this._appDisplay?.actor,
            this._appDisplay?._view?.actor,
            this._appDisplay?._view,
            this._appDisplay?._views?.[0]?.actor,
            this._appDisplay?._views?.[0],
            Main.uiGroup,
        ].filter(Boolean);

        const queue = [...roots];
        const seen = new Set();

        while (queue.length > 0) {
            const node = queue.shift();
            if (!node || seen.has(node))
                continue;
            seen.add(node);

            if (node === this._canvas || node.name === 'honeycombCanvas')
                continue;

            const text = this._getActorDebugText(node);
            const isIndicator =
                text.includes('page-indicators') ||
                text.includes('page-indicator') ||
                text.includes('pageindicators') ||
                text.includes('pagination');
            const isPageArrow =
                text.includes('page-arrow') ||
                text.includes('pagearrow') ||
                text.includes('page-navigation') ||
                text.includes('next-page') ||
                text.includes('nextpage') ||
                text.includes('previous-page') ||
                text.includes('previouspage') ||
                text.includes('prev-page') ||
                text.includes('prevpage');

            if (isIndicator)
                this._addNavigationCandidate(nav, 'pageIndicators', node);
            if (isPageArrow) {
                const looksLeft =
                    text.includes('previous') ||
                    text.includes('prev') ||
                    text.includes('left');
                const looksRight =
                    text.includes('next') ||
                    text.includes('right');

                if (looksLeft || !looksRight)
                    this._addNavigationCandidate(nav, 'leftArrow', node);
                if (looksRight || !looksLeft)
                    this._addNavigationCandidate(nav, 'rightArrow', node);
            }

            if (typeof node.get_children === 'function') {
                for (const child of node.get_children())
                    queue.push(child);
            }
        }

        return nav;
    }

    _restoreHiddenNavigationActors() {
        if (this._hiddenNavigationActors.size > 0)
            hlog('Stock AppGrid navigation restored');

        for (const [actor, state] of this._hiddenNavigationActors.entries()) {
            try {
                actor.visible = state.visible;
                actor.opacity = state.opacity;
                if ('reactive' in actor)
                    actor.reactive = state.reactive;
            } catch (e) {
                // Actor disappeared with the overview lifecycle.
            }
        }
        this._hiddenNavigationActors.clear();
        this._stockNavigationLogged = false;
    }

    _hideStockGrid() {
        const actor = this._gridHintActor ?? this._appGridActor;
        if (!actor || this._stockGridState)
            return;

        try {
            this._stockGridState = {
                actor,
                visible: actor.visible,
                opacity: actor.opacity,
                reactive: actor.reactive,
            };
            actor.opacity = 0;
            if ('reactive' in actor)
                actor.reactive = false;
            hlog(`Stock AppGrid hidden: ${actor.constructor?.name ?? 'n/a'}`);
        } catch (e) {
            hlog(`Failed to hide stock AppGrid: ${e?.message ?? e}`);
            this._stockGridState = null;
        }
    }

    _restoreStockGrid() {
        const state = this._stockGridState;
        if (!state?.actor)
            return;

        try {
            state.actor.visible = state.visible;
            state.actor.opacity = state.opacity;
            if ('reactive' in state.actor)
                state.actor.reactive = state.reactive;
        } catch (e) {
            // Actor disappeared with the overview lifecycle.
        }
        this._stockGridState = null;
    }

    _forcePageZero(obj) {
        if (!obj)
            return;

        try {
            if (typeof obj.goToPage === 'function')
                obj.goToPage(0, false);
        } catch (e) {
            // Optional API.
        }

        try {
            if (typeof obj.setCurrentPage === 'function')
                obj.setCurrentPage(0);
        } catch (e) {
            // Optional API.
        }

        for (const key of ['page', 'currentPage', '_currentPage']) {
            try {
                if (typeof obj[key] === 'number' && obj[key] !== 0)
                    obj[key] = 0;
            } catch (e) {
                // Optional field.
            }
        }
    }

    _hidePaginationUI() {
        const nav = this._discoverStockNavigationActors();
        this._pageIndicatorsActor = nav.pageIndicators[0] ?? null;

        if (!this._stockNavigationLogged) {
            hlog(`Stock navigation: leftArrow=${nav.leftArrow.length > 0 ? 'found' : 'missing'} rightArrow=${nav.rightArrow.length > 0 ? 'found' : 'missing'} pageIndicators=${nav.pageIndicators.length > 0 ? 'found' : 'missing'}`);
            this._stockNavigationLogged = true;
        }

        const actors = [
            ...nav.leftArrow,
            ...nav.rightArrow,
            ...nav.pageIndicators,
        ];

        for (const actor of actors)
            this._hideActorForRestore(actor);

        if (actors.length > 0)
            hlog('Stock AppGrid navigation hidden');

        if (this._gridLockedSignalIds.length > 0)
            return;

        const candidates = [
            this._appDisplay?._view,
            this._appDisplay?._views?.[0],
            this._appDisplay?._views?.[0]?._grid,
            this._appDisplay?._grid,
            this._appDisplay,
            Main.overview?._overview?.controls?._appDisplay,
        ].filter(Boolean);

        const lockSignals = ['notify::page', 'notify::current-page', 'notify::currentPage'];
        const seen = new Set();

        for (const obj of candidates) {
            if (seen.has(obj))
                continue;
            seen.add(obj);

            this._forcePageZero(obj);

            for (const signal of lockSignals) {
                try {
                    const id = obj.connect(signal, () => this._forcePageZero(obj));
                    this._gridLockedSignalIds.push([obj, id]);
                } catch (e) {
                    // Signal not supported on this object.
                }
            }
        }
    }

    _disconnectGridLockSignals() {
        for (const [obj, id] of this._gridLockedSignalIds.splice(0)) {
            try {
                obj.disconnect(id);
            } catch (e) {
                // Object or signal unavailable.
            }
        }
    }

    _restoreCanvasState() {
        if (this._state === 'idle' &&
            !this._viewport &&
            !this._canvas &&
            this._originalParents.size === 0 &&
            this._honeycombItems.length === 0 &&
            !this._stockGridState &&
            this._hiddenNavigationActors.size === 0)
            return;

        this._state = 'restoring';
        this._activationGeneration++;
        this._resetInteractionState('restore');
        this._clearPendingActivation();
        this._cancelCanvasAllocationWait();
        this._cancelActivationIdles();
        this._canvasSignals.disconnectAll();
        this._disconnectGridLockSignals();
        this._restoreTransforms();
        this._destroyHoneycombVisualItems();
        this._restoreStockGrid();
        this._restoreHiddenNavigationActors();

        const restoreEntries = Array.from(this._originalParents.entries());
        restoreEntries.sort((a, b) => (a[1]?.index ?? 0) - (b[1]?.index ?? 0));

        for (const [icon, info] of restoreEntries) {
            const parent = info?.parent;
            if (!icon || !parent)
                continue;

            try {
                if (icon.get_parent?.() === this._canvas)
                    this._canvas.remove_child(icon);
            } catch (e) {
                // Already detached.
            }

            try {
                if (typeof parent.insert_child_at_index === 'function' && Number.isInteger(info.index) && info.index >= 0)
                    parent.insert_child_at_index(icon, info.index);
                else
                    parent.add_child(icon);
            } catch (e) {
                // Parent no longer valid.
            }
        }

        this._originalParents.clear();
        this._pageIndicatorsActor = null;
        this._pageIndicatorsState = null;

        if (this._canvas) {
            try {
                this._canvas.destroy();
            } catch (e) {
                // Already destroyed.
            }
        }
        if (this._viewport) {
            try {
                this._viewport.destroy();
            } catch (e) {
                // Already destroyed.
            }
        }
        this._viewport = null;
        this._canvas = null;
        this._canvasLayout = null;
        this._cleanupOrphanCanvases();
        this._canvasHostActor = null;
        this._honeycombIcons = [];
        this._honeycombItems = [];
        this._singleCanvasActive = false;
        this._active = false;
        this._viewportRect = null;
        this._lastViewportSample = null;
        this._stableViewportSamples = 0;
        this._viewportSampleCount = 0;
        this._basePositions.clear();
        this._lastSignature = '';
        this._state = 'idle';
        hlog('Honeycomb restore complete; state=idle');
    }

    _getIconActors() {
        return this._getHoneycombIcons();
    }

    _getHoneycombIcons() {
        if (this._singleCanvasActive && this._honeycombIcons.length > 0) {
            return this._honeycombIcons.filter(icon => {
                try {
                    return icon && icon.get_parent?.() === this._canvas;
                } catch (e) {
                    return false;
                }
            });
        }

        if (!this._appGridActor)
            return [];

        return this._collectAllIconTiles();
    }

    _getViewport() {
        if (!this._appDisplayActor && !this._appGridActor)
            return {width: 0, height: 0};

        try {
            const target = this._canvas ?? this._appDisplayActor ?? this._appGridActor;
            const box = target.get_allocation_box();
            const width = Math.max(0, box.x2 - box.x1);
            const height = Math.max(0, box.y2 - box.y1);
            if (width > 0 && height > 0)
                return {width, height};
        } catch (e) {
            // Fall through to explicit actor size.
        }

        const target = this._canvas ?? this._appDisplayActor ?? this._appGridActor;
        return this._getActorSize(target);
    }

    _syncCanvasIcons() {
        // Dedicated Honeycomb actors are used; stock GNOME tiles are never moved.
    }

    _refreshLayoutIfNeeded() {
        this._syncCanvasIcons();
        const icons = this._getIconActors();
        const {width, height} = this._getViewport();
        const signature = `${icons.length}:${Math.round(width)}x${Math.round(height)}`;

        if (signature === this._lastSignature)
            return;

        this._refreshLayout();
    }

    _normalizeYaw(yaw) {
        const fullTurn = Math.PI * 2;
        let normalized = yaw % fullTurn;
        if (normalized > Math.PI)
            normalized -= fullTurn;
        else if (normalized < -Math.PI)
            normalized += fullTurn;
        return normalized;
    }

    _calculateFibonacciSpherePositions(count) {
        if (count <= 0)
            return [];

        if (count === 1) {
            return [{
                sphereX: 0,
                sphereY: 0,
                sphereZ: 1,
                theta: 0,
                phi: Math.PI / 2,
            }];
        }

        const positions = [];
        const goldenAngle = Math.PI * (3 - Math.sqrt(5));

        for (let i = 0; i < count; i++) {
            const y = 1 - (i / (count - 1)) * 2;
            const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
            const theta = goldenAngle * i;
            const x = Math.cos(theta) * radiusAtY;
            const z = Math.sin(theta) * radiusAtY;
            const phi = Math.acos(clamp(y, -1, 1));

            positions.push({
                sphereX: x,
                sphereY: y,
                sphereZ: z,
                theta,
                phi,
            });
        }

        return positions;
    }

    _projectSphereItem(item, width, height) {
        const yaw = this._rotationYaw;
        const pitch = this._rotationPitch;
        const cosYaw = Math.cos(yaw);
        const sinYaw = Math.sin(yaw);
        const cosPitch = Math.cos(pitch);
        const sinPitch = Math.sin(pitch);

        const x = item.sphereX ?? 0;
        const y = item.sphereY ?? 0;
        const z = item.sphereZ ?? 1;

        const x1 = x * cosYaw + z * sinYaw;
        const z1 = -x * sinYaw + z * cosYaw;
        const y1 = y;

        const ry = y1 * cosPitch - z1 * sinPitch;
        const rz = y1 * sinPitch + z1 * cosPitch;
        const rx = x1;

        const centerX = width / 2;
        const centerY = height / 2;
        const radiusX = Math.min(width * 0.31, 600);
        const radiusY = Math.min(height * 0.39, 300);
        const screenX = centerX + rx * radiusX;
        const screenY = centerY + ry * radiusY;
        const depthNormalized = clamp((rz + 1) / 2, 0, 1);
        const baseScale = BACK_SCALE + (FRONT_SCALE - BACK_SCALE) * depthNormalized;
        const visibility = clamp((rz - BACK_CUTOFF) / 0.25, 0, 1);

        return {screenX, screenY, rz, baseScale, visibility};
    }

    _refreshLayout(force = false) {
        hlog('refreshLayout entered');

        try {
            if (!this._active || !this._appGridActor)
                return false;

            if (!this._canvas) {
                hlog('LAYOUT ABORT: canvas missing');
                return false;
            }

            if (this._honeycombItems.length === 0) {
                hlog('LAYOUT ABORT: honeycombItems empty');
                return false;
            }

            this._syncCanvasIcons();

            const icons = this._getIconActors();
            const {width, height} = this._getViewport();
            hlog(`refreshLayout items=${this._honeycombItems.length}`);
            hlog(`refreshLayout canvas allocated=${this._canvas?.has_allocation?.()}`);
            hlog(`refreshLayout canvas size=${this._canvas?.width}x${this._canvas?.height}`);

            if (icons.length === 0 || width <= 0 || height <= 0)
                return false;

            const count = this._honeycombItems.length;
            const spherePositions = this._calculateFibonacciSpherePositions(count);

            hlog('refreshLayout creating sphere positions');
            this._basePositions.clear();

            for (let i = 0; i < count; i++) {
                const item = this._honeycombItems[i];
                const icon = item.visualActor;
                const sphere = spherePositions[i];
                item.sphereX = sphere.sphereX;
                item.sphereY = sphere.sphereY;
                item.sphereZ = sphere.sphereZ;
                item.theta = sphere.theta;
                item.phi = sphere.phi;

                const projected = this._projectSphereItem(item, width, height);
                item.baseX = projected.screenX;
                item.baseY = projected.screenY;
                item.currentX = projected.screenX;
                item.currentY = projected.screenY;
                item.currentScale = projected.baseScale;
                item.targetX = projected.screenX;
                item.targetY = projected.screenY;
                item.targetScale = projected.baseScale;
                item.currentOpacity = projected.visibility * 255;
                item.targetOpacity = projected.visibility * 255;
                item.rz = projected.rz;
                this._basePositions.set(icon, {x: projected.screenX, y: projected.screenY});
            }

            hlog(`Orbital honeycomb sphere layout: items=${count} canvas=${Math.round(width)}x${Math.round(height)} center=${Math.round(width / 2)},${Math.round(height / 2)}`);
            for (let i = 0; i < Math.min(5, count); i++) {
                const pos = this._basePositions.get(this._honeycombItems[i].visualActor);
                hlog(`Item[${i}] pos=${Math.round(pos.x)},${Math.round(pos.y)}`);
            }

            this._lastSignature = `${icons.length}:${Math.round(width)}x${Math.round(height)}`;
            const appliedCount = this._applyOrbitalLayout();
            hlog(`Orbital layout applied: ${appliedCount}/${this._honeycombItems.length}`);
            hlog(`Honeycomb visual layout applied: ${appliedCount}/${this._honeycombItems.length}`);
            return true;
        } catch (e) {
            hlog(`refreshLayout ERROR: ${e?.message ?? e}`);
            logError(e, '[GNOME Honeycomb] refreshLayout exception');
            return false;
        }
    }

    _applyOrbitalLayout() {
        if (!this._active || !this._appGridActor || this._honeycombItems.length === 0)
            return 0;

        let appliedCount = 0;
        const {width, height} = this._getViewport();
        if (width <= 0 || height <= 0)
            return 0;

        for (const item of this._honeycombItems) {
            const actor = item.visualActor;
            if (!actor)
                continue;

            const projected = this._projectSphereItem(item, width, height);
            const centerX = projected.screenX;
            const centerY = projected.screenY;
            const x = centerX - ITEM_SIZE / 2;
            const y = centerY - ITEM_SIZE / 2;
            const opacity = Math.round(projected.visibility * 255);

            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                hlog(`Invalid coordinates for direct item: ${x},${y}`);
                continue;
            }

            try {
                actor.remove_all_transitions?.();
                try {
                    actor.set_pivot_point?.(0, 0);
                } catch (e) {
                    // Optional API.
                }
                try {
                    actor.translation_x = 0;
                    actor.translation_y = 0;
                    if ('translation_z' in actor)
                        actor.translation_z = 0;
                } catch (e) {
                    // Optional properties.
                }
                actor.visible = opacity > 0;
                actor.opacity = opacity;
                if ('reactive' in actor)
                    actor.reactive = opacity > 32;
                actor.set_size?.(ITEM_SIZE, ITEM_SIZE);
                actor.set_position(Math.round(x), Math.round(y));
                actor.set_scale?.(projected.baseScale, projected.baseScale);
                item.iconActor?.set_size?.(ICON_SIZE, ICON_SIZE);
                item.currentX = centerX;
                item.currentY = centerY;
                item.currentScale = projected.baseScale;
                item.currentOpacity = opacity;
                item.targetX = centerX;
                item.targetY = centerY;
                item.targetScale = projected.baseScale;
                item.targetOpacity = opacity;
                item.rz = projected.rz;
                appliedCount++;
            } catch (e) {
                hlog(`Failed direct-position layout for one item: ${e?.message ?? e}`);
            }
        }

        return appliedCount;
    }

    _updateInteractionTargets() {
        const hasPointer = this._pointerX !== null && this._pointerY !== null;
        const {width, height} = this._getViewport();
        if (width <= 0 || height <= 0)
            return;

        for (const item of this._honeycombItems) {
            const projected = this._projectSphereItem(item, width, height);
            const cx = projected.screenX;
            const cy = projected.screenY;
            let targetX = cx;
            let targetY = cy;
            let targetScale = projected.baseScale;
            const targetOpacity = projected.visibility * 255;

            if (hasPointer && projected.visibility > 0) {
                const dx = cx - this._pointerX;
                const dy = cy - this._pointerY;
                const distance = Math.hypot(dx, dy);
                const ratio = distance / MAGNET_RADIUS;
                const w = Math.exp(-(ratio * ratio));
                const magneticMultiplier = 1.0 + MAGNETIC_SPHERE_SCALE * w;
                targetScale = projected.baseScale * magneticMultiplier;

                if (distance > 1) {
                    targetX += (dx / distance) * MAGNET_REPULSION * w;
                    targetY += (dy / distance) * MAGNET_REPULSION * w;
                }
            }

            item.targetX = targetX;
            item.targetY = targetY;
            item.targetScale = targetScale;
            item.targetOpacity = targetOpacity;
            item.rz = projected.rz;
        }
    }

    _runInteractionFrame() {
        this._updateInteractionTargets();

        let keepGoing = false;
        for (const item of this._honeycombItems) {
            const actor = item.visualActor;
            if (!actor)
                continue;

            const dx = item.targetX - item.currentX;
            const dy = item.targetY - item.currentY;
            const ds = item.targetScale - item.currentScale;
            const dop = item.targetOpacity - (item.currentOpacity ?? 255);

            if (Math.abs(dx) < 0.05)
                item.currentX = item.targetX;
            else
                item.currentX += dx * INTERACTION_LERP;

            if (Math.abs(dy) < 0.05)
                item.currentY = item.targetY;
            else
                item.currentY += dy * INTERACTION_LERP;

            if (Math.abs(ds) < 0.002)
                item.currentScale = item.targetScale;
            else
                item.currentScale += ds * INTERACTION_LERP;

            if (Math.abs(dop) < 1)
                item.currentOpacity = item.targetOpacity;
            else
                item.currentOpacity = (item.currentOpacity ?? 255) + dop * INTERACTION_LERP;

            if (item.currentX !== item.targetX ||
                item.currentY !== item.targetY ||
                item.currentScale !== item.targetScale ||
                item.currentOpacity !== item.targetOpacity)
                keepGoing = true;

            try {
                actor.set_pivot_point?.(0.5, 0.5);
            } catch (e) {
                // Optional API.
            }
            actor.set_position(
                Math.round(item.currentX - ITEM_SIZE / 2),
                Math.round(item.currentY - ITEM_SIZE / 2)
            );
            actor.set_scale?.(item.currentScale, item.currentScale);
            actor.opacity = Math.round(clamp(item.currentOpacity ?? 255, 0, 255));
            actor.visible = actor.opacity > 0;
            if ('reactive' in actor)
                actor.reactive = actor.opacity > 32;
        }

        this._applyInteractionStacking();
        return keepGoing || this._dragging || this._pressing;
    }

    _applyInteractionStacking() {
        if (!this._canvas?.set_child_above_sibling)
            return;

        const sorted = [...this._honeycombItems].sort((a, b) => {
            const depthDiff = (a.rz ?? 0) - (b.rz ?? 0);
            if (Math.abs(depthDiff) > 0.0001)
                return depthDiff;
            return a.currentScale - b.currentScale;
        });
        let previous = null;
        for (const item of sorted) {
            try {
                this._canvas.set_child_above_sibling(item.visualActor, previous);
                previous = item.visualActor;
            } catch (e) {
                // Ignore stacking issues for individual actors.
            }
        }
    }

    _restoreTransforms() {
        for (const [icon, state] of this._originalTransforms.entries()) {
            try {
                try {
                    icon.remove_all_transitions();
                } catch (e) {
                    // Optional API depending on actor implementation.
                }
                icon.set_position(state.x, state.y);
                icon.set_scale(state.scaleX, state.scaleY);
                try {
                    icon.set_z_position(0);
                } catch (e) {
                    // Optional API depending on actor implementation.
                }
            } catch (e) {
                // Actor already gone.
            }
        }
    }

    _isSearchActive() {
        try {
            if (Main.overview.searchActive)
                return true;
        } catch (e) {
            // Not available on all versions.
        }

        const searchController =
            Main.overview?._overview?.controls?._searchController ??
            Main.overview?._controls?._searchController ??
            null;

        if (searchController) {
            if (searchController.searchActive)
                return true;
            if (searchController._searchActive)
                return true;
        }

        try {
            const entry = Main.overview.searchEntry ?? searchController?._text;
            if (entry && typeof entry.get_text === 'function' && entry.get_text().trim().length > 0)
                return true;
        } catch (e) {
            // Ignore missing entry.
        }

        return false;
    }

    _isAppGridActive() {
        if (!this._active || !this._appGridActor)
            return false;

        if (!Main.overview?.visible)
            return false;

        if (!this._appGridActor.visible || !this._appGridActor.mapped)
            return false;

        return true;
    }
}

export default class GnomeHoneycombExtension extends Extension {
    enable() {
        this._controller = new HoneycombController();
        this._controller.enable();
        hlog('Extension enabled.');
    }

    disable() {
        if (this._controller) {
            this._controller.disable();
            this._controller = null;
        }
        hlog('Extension disabled.');
    }
}
