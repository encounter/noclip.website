
import { mat4, ReadonlyVec3, vec3 } from 'gl-matrix';
import { randomRange } from '../BanjoKazooie/particles';
import { IS_DEVELOPMENT } from '../BuildVersion';
import { colorNewCopy, Cyan, Green, Magenta, Red, White } from '../Color';
import { drawWorldSpaceAABB, drawWorldSpaceLine, drawWorldSpacePoint, drawWorldSpaceText, getDebugOverlayCanvas2D } from '../DebugJunk';
import { AABB } from '../Geometry';
import { GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager';
import { clamp, computeModelMatrixSRT, getMatrixTranslation, invlerp, lerp, MathConstants, saturate, transformVec3Mat4w1 } from '../MathHelpers';
import { assert, assertExists, fallbackUndefined } from '../util';
import { BSPModelRenderer, SourceRenderContext, BSPRenderer, SourceEngineView } from './Main';
import { BaseMaterial, EntityMaterialParameters, LightCache, ParameterReference, paramSetNum } from './Materials';
import { computeModelMatrixPosQAngle, StudioModelInstance } from "./Studio";
import { BSPEntity, vmtParseNumber, vmtParseVector } from './VMT';

interface EntityOutputAction {
    targetName: string;
    inputName: string;
    parameterOverride: string;
    delay: number;
    timesToFire: number;
}

function parseEntityOutputAction(S: string): EntityOutputAction {
    let parts: string[];
    if (S.includes('\x1b'))
        parts = S.split('\x1b');
    else
        parts = S.split(',');
    assert(parts.length === 5);
    const [targetName, inputNameStr, parameterOverride, delayStr, timesToFireStr] = parts;
    const inputName = inputNameStr.toLowerCase();
    const delay = Number(delayStr);
    const timesToFire = Number(timesToFireStr);
    return { targetName, inputName, parameterOverride, delay, timesToFire };
}

class EntityOutput {
    public actions: EntityOutputAction[] = [];

    public parse(S: string | string[] | undefined): void {
        if (Array.isArray(S))
            S.forEach((s) => this.parse(s));
        else if (S !== undefined)
            this.actions.push(parseEntityOutputAction(S));
    }

    public fire(entitySystem: EntitySystem, activator: BaseEntity, value: string = ''): void {
        for (let i = 0; i < this.actions.length; i++)
            entitySystem.queueEntityOutputAction(this.actions[i], activator, value);
    }
}

type EntityInputFunc = (entitySystem: EntitySystem, value: string) => void;

const scratchMat4a = mat4.create();

// Some part of this is definitely BaseAnimating, maybe split at some point?
export class BaseEntity {
    public modelBSP: BSPModelRenderer | null = null;
    public modelStudio: StudioModelInstance | null = null;

    public localOrigin = vec3.create();
    public angles = vec3.create();
    public renderamt: number = 1.0;
    public visible = true;
    public materialParams: EntityMaterialParameters | null = null;
    public skin: number = 0;
    public lightingOrigin = vec3.create();

    public targetName: string | null = null;
    public parentEntity: BaseEntity | null = null;
    public alive = true;
    public enabled = true;

    public outputs: EntityOutput[] = [];
    public inputs = new Map<string, EntityInputFunc>();

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, private bspRenderer: BSPRenderer, protected entity: BSPEntity) {
        if (entity.model) {
            this.materialParams = new EntityMaterialParameters();

            if (entity.model.startsWith('*')) {
                const index = parseInt(entity.model.slice(1), 10);
                this.modelBSP = bspRenderer.models[index];
                this.modelBSP.setEntity(this);
            } else if (entity.model.endsWith('.mdl')) {
                // External model reference.
                this.fetchStudioModel(renderContext);
            }
        }

        if (entity.origin) {
            const origin = vmtParseVector(entity.origin);
            vec3.set(this.localOrigin, origin[0], origin[1], origin[2]);
        }

        if (entity.angles) {
            const angles = vmtParseVector(entity.angles);
            vec3.set(this.angles, angles[0], angles[1], angles[2]);
        }

        this.renderamt = vmtParseNumber(entity.renderamt, 255.0) / 255.0;

        if (entity.targetname)
            this.targetName = '' + entity.targetname;

        this.skin = vmtParseNumber(entity.skin, 0);

        if (entity.startdisabled)
            this.enabled = !Number(entity.startdisabled);
        else if (entity.start_disabled)
            this.enabled = !Number(entity.start_disabled);

        this.registerInput('enable', this.input_enable.bind(this));
        this.registerInput('disable', this.input_disable.bind(this));
        this.registerInput('kill', this.input_kill.bind(this));
        this.registerInput('skin', this.input_skin.bind(this));

        // Set up some defaults.
        if (this.entity.classname.startsWith('func_nav_'))
            this.visible = false;
    }

    private input_enable(): void {
        this.enabled = true;
    }

    private input_disable(): void {
        this.enabled = false;
    }

    private input_kill(): void {
        this.remove();
    }

    private input_skin(entitySystem: EntitySystem, value: string): void {
        this.skin = Number(value) || 0;
    }

    protected remove(): void {
        this.alive = false;
    }

    protected registerInput(inputName: string, func: EntityInputFunc): void {
        assert(!this.inputs.has(inputName));
        this.inputs.set(inputName, func);
    }

    public fireInput(entitySystem: EntitySystem, inputName: string, value: string): void {
        const func = this.inputs.get(inputName);
        if (!func) {
            console.warn(`Unknown input: ${this.targetName} (${this.entity.classname}) ${inputName} ${value}`);
            return;
        }

        func(entitySystem, value);
    }

    private updateLightingData(): void {
        const materialParams = this.materialParams!;

        const modelMatrix = this.updateModelMatrix()!;
        getMatrixTranslation(materialParams.position, modelMatrix);

        if (this.modelStudio !== null) {
            transformVec3Mat4w1(this.lightingOrigin, modelMatrix, this.modelStudio.modelData.illumPosition);
        } else {
            vec3.copy(this.lightingOrigin, materialParams.position);
        }

        materialParams.lightCache = new LightCache(this.bspRenderer.bsp, this.lightingOrigin, this.modelStudio!.modelData.bbox);
    }

    protected modelUpdated(): void {
    }

    private async fetchStudioModel(renderContext: SourceRenderContext) {
        const modelData = await renderContext.studioModelCache.fetchStudioModelData(this.entity.model!);
        this.modelStudio = new StudioModelInstance(renderContext, modelData, this.materialParams!);
        this.modelStudio.setSkin(renderContext, this.skin);
        this.modelUpdated();
        this.updateLightingData();
    }

    private animindex = 0;
    private animtime = 0;
    private animplay: boolean = false;

    public prepareToRender(renderContext: SourceRenderContext, renderInstManager: GfxRenderInstManager, view: SourceEngineView): void {
        if (!this.visible || !this.enabled || !this.alive)
            return;

        if (this.modelBSP !== null) {
            // BSP models are rendered by the BSP system.
        } else if (this.modelStudio !== null) {
            // idle animation pose?
            if (this.animplay)
                this.animtime += renderContext.globalDeltaTime * 60;
            this.modelStudio.setupPoseFromAnimation(this.animindex, this.animtime);
            this.modelStudio.setSkin(renderContext, this.skin);
            this.modelStudio.prepareToRender(renderContext, renderInstManager);

            if ((this as any).debug)
                this.materialParams!.lightCache!.debugDrawLights(renderContext.currentView);
        }
    }

    protected setAbsOrigin(v: ReadonlyVec3): void {
        if (this.parentEntity !== null) {
            const parentModelMatrix = this.parentEntity.updateModelMatrix();
            if (parentModelMatrix !== null) {
                mat4.invert(scratchMat4a, parentModelMatrix);
                transformVec3Mat4w1(this.localOrigin, scratchMat4a, v);
                return;
            }
        }

        vec3.copy(this.localOrigin, v);
    }

    public getAbsOrigin(dst: vec3): void {
        if (this.parentEntity !== null) {
            const parentModelMatrix = this.parentEntity.updateModelMatrix();
            if (parentModelMatrix !== null) {
                transformVec3Mat4w1(dst, parentModelMatrix, this.localOrigin);
                return;
            }
        }

        vec3.copy(dst, this.localOrigin);
    }

    public setParentEntity(parentEntity: BaseEntity | null): void {
        if (parentEntity === this.parentEntity)
            return;

        // Transform origin into absolute world-space.
        this.getAbsOrigin(this.localOrigin);

        this.parentEntity = parentEntity;

        // Transform origin from world-space into entity space.
        this.setAbsOrigin(this.localOrigin);
    }

    public spawn(entitySystem: EntitySystem): void {
        if (this.entity.parentname)
            this.setParentEntity(entitySystem.findEntityByTargetName(this.entity.parentname));
    }

    protected getModelMatrix(): mat4 | null {
        if (this.modelBSP !== null)
            return this.modelBSP.modelMatrix;
        else if (this.modelStudio !== null)
            return this.modelStudio.modelMatrix;
        else
            return null;
    }

    protected updateModelMatrix(): mat4 | null {
        const modelMatrix = this.getModelMatrix();
        if (modelMatrix === null)
            return null;

        computeModelMatrixPosQAngle(modelMatrix, this.localOrigin, this.angles);

        if (this.parentEntity !== null) {
            const parentModelMatrix = this.parentEntity.updateModelMatrix();
            if (parentModelMatrix !== null)
                mat4.mul(modelMatrix, parentModelMatrix, modelMatrix);
        }

        return modelMatrix;
    }

    public movement(entitySystem: EntitySystem, renderContext: SourceRenderContext): void {
        if (this.modelBSP !== null || this.modelStudio !== null) {
            const modelMatrix = this.updateModelMatrix()!;
            getMatrixTranslation(this.materialParams!.position, modelMatrix);

            let visible = this.visible;
            if (this.renderamt === 0)
                visible = false;

            if (this.modelBSP !== null)
                this.modelBSP.visible = visible;
            else if (this.modelStudio !== null)
                this.modelStudio.visible = visible;
        }
    }
}

export class sky_camera extends BaseEntity {
    public static classname = 'sky_camera';
    public area: number = -1;
    public scale: number = 1;
    public modelMatrix = mat4.create();

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);
        const leaf = assertExists(bspRenderer.bsp.findLeafForPoint(this.localOrigin));
        this.area = leaf.area;
        this.scale = Number(entity.scale);
        computeModelMatrixSRT(this.modelMatrix, this.scale, this.scale, this.scale, 0, 0, 0,
            this.scale * -this.localOrigin[0],
            this.scale * -this.localOrigin[1],
            this.scale * -this.localOrigin[2]);
    }
}

class water_lod_control extends BaseEntity {
    public static classname = 'water_lod_control';

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);
        if (entity.cheapwaterstartdistance !== undefined)
            renderContext.cheapWaterStartDistance = Number(entity.cheapwaterstartdistance);
        if (entity.cheapwaterenddistance !== undefined)
            renderContext.cheapWaterEndDistance = Number(entity.cheapwaterenddistance);
    }
}

function angleVec(dstForward: vec3, rot: ReadonlyVec3): void {
    const rx = rot[0] * MathConstants.DEG_TO_RAD, ry = rot[1] * MathConstants.DEG_TO_RAD;
    const sx = Math.sin(rx), cx = Math.cos(rx);
    const sy = Math.sin(ry), cy = Math.cos(ry);

    dstForward[0] = cx*cy;
    dstForward[1] = cx*sy;
    dstForward[2] = -sx;
}

const enum ToggleState {
    Top, Bottom, GoingToTop, GoingToBottom,
}

abstract class BaseToggle extends BaseEntity {
    public moveDir = vec3.create();
    public startPosition: number;
    public moveDistance: number;
    public speed: number;
    
    protected positionOpened = vec3.create();
    protected positionClosed = vec3.create();

    protected timeLeftInSeconds = 0.0;
    protected positionTarget = vec3.create();
    protected velocityPerSecond = vec3.create();

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        vec3.copy(this.moveDir, vmtParseVector(fallbackUndefined(this.entity.movedir, "")) as vec3);
        this.startPosition = Number(fallbackUndefined(this.entity.startposition, '0'));
        this.moveDistance = Number(fallbackUndefined(this.entity.movedistance, '0'));
        this.speed = Number(fallbackUndefined(this.entity.speed, '0'));
    }

    protected moveToTargetPos(entitySystem: EntitySystem, positionTarget: ReadonlyVec3, speedInSeconds: number): void {
        vec3.copy(this.positionTarget, positionTarget);
        vec3.sub(this.velocityPerSecond, this.positionTarget, this.localOrigin);
        this.timeLeftInSeconds = vec3.length(this.velocityPerSecond) / speedInSeconds;
        if (this.timeLeftInSeconds <= 0.0)
            this.moveDone(entitySystem);
        else
            vec3.scale(this.velocityPerSecond, this.velocityPerSecond, 1.0 / this.timeLeftInSeconds);
    }

    public movement(entitySystem: EntitySystem, renderContext: SourceRenderContext): void {
        super.movement(entitySystem, renderContext);

        const deltaTimeInSeconds = renderContext.globalDeltaTime;

        if (this.timeLeftInSeconds > 0.0) {
            // Apply the velocity.
            vec3.scaleAndAdd(this.localOrigin, this.localOrigin, this.velocityPerSecond, deltaTimeInSeconds);
            this.timeLeftInSeconds -= deltaTimeInSeconds;

            // If we've reached the target position, then we're done.
            if (this.timeLeftInSeconds <= 0.0) {
                vec3.copy(this.localOrigin, this.positionTarget);
                vec3.zero(this.velocityPerSecond);
                this.timeLeftInSeconds = 0.0;
                this.moveDone(entitySystem);
            }
        }
    }

    protected abstract moveDone(entitySystem: EntitySystem): void;
}

const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();
class func_movelinear extends BaseToggle {
    public static classname = `func_movelinear`;

    private output_onFullyClosed = new EntityOutput();
    private output_onFullyOpen = new EntityOutput();

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        this.output_onFullyOpen.parse(this.entity.onfullyopen);
        this.output_onFullyClosed.parse(this.entity.onfullyclosed);
        this.registerInput('open', this.input_open.bind(this));
        this.registerInput('close', this.input_close.bind(this));
    }

    public spawn(entitySystem: EntitySystem): void {
        super.spawn(entitySystem);

        angleVec(scratchVec3a, this.moveDir);
        vec3.scaleAndAdd(this.positionOpened, this.localOrigin, scratchVec3a, -this.moveDistance * this.startPosition);
        vec3.scaleAndAdd(this.positionClosed, this.localOrigin, scratchVec3a,  this.moveDistance);
    }

    protected moveDone(entitySystem: EntitySystem): void {
        if (vec3.distance(this.localOrigin, this.positionClosed) < MathConstants.EPSILON)
            this.output_onFullyClosed.fire(entitySystem, this);
        if (vec3.distance(this.localOrigin, this.positionOpened) < MathConstants.EPSILON)
            this.output_onFullyOpen.fire(entitySystem, this);
    }

    private input_open(entitySystem: EntitySystem): void {
        this.moveToTargetPos(entitySystem, this.positionOpened, this.speed);
    }

    private input_close(entitySystem: EntitySystem): void {
        this.moveToTargetPos(entitySystem, this.positionClosed, this.speed);
    }
}

class func_door extends BaseToggle {
    public static classname = `func_door`;

    private output_onClose = new EntityOutput();
    private output_onOpen = new EntityOutput();
    private output_onFullyClosed = new EntityOutput();
    private output_onFullyOpen = new EntityOutput();

    private modelExtents = vec3.create();
    private locked: boolean = false;
    protected toggleState: ToggleState;

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        // TODO(jstpierre): Rotating doors

        this.output_onClose.parse(this.entity.onclose);
        this.output_onOpen.parse(this.entity.onopen);
        this.output_onFullyClosed.parse(this.entity.onfullyclosed);
        this.output_onFullyOpen.parse(this.entity.onfullyopen);

        this.registerInput('close', this.input_close.bind(this));
        this.registerInput('open', this.input_open.bind(this));
        this.registerInput('toggle', this.input_toggle.bind(this));

        const spawnpos = Number(fallbackUndefined(this.entity.spawnpos, '0'));
        if (spawnpos === 1)
            this.toggleState = ToggleState.Top;
        else
            this.toggleState = ToggleState.Bottom;
    }

    public spawn(entitySystem: EntitySystem): void {
        super.spawn(entitySystem);

        vec3.copy(this.positionOpened, this.localOrigin);
        vec3.copy(this.positionClosed, this.localOrigin);

        this.updateExtents();
    }

    private updateExtents(): void {
        if (this.modelBSP !== null)
            this.modelBSP.model.bbox.extents(this.modelExtents);
        else if (this.modelStudio !== null)
            this.modelStudio.modelData.bbox.extents(this.modelExtents);

        angleVec(scratchVec3a, this.moveDir);
        const moveDistance = Math.abs(vec3.dot(scratchVec3a, this.modelExtents) * 2.0);
        vec3.scaleAndAdd(this.positionOpened, this.positionClosed, scratchVec3a, moveDistance);
    }

    protected modelUpdated(): void {
        this.updateExtents();
    }

    private goToTop(entitySystem: EntitySystem): void {
        this.toggleState = ToggleState.GoingToTop;
        this.moveToTargetPos(entitySystem, this.positionOpened, this.speed);
        this.output_onOpen.fire(entitySystem, this);
    }

    private goToBottom(entitySystem: EntitySystem): void {
        this.toggleState = ToggleState.GoingToBottom;
        this.moveToTargetPos(entitySystem, this.positionClosed, this.speed);
        this.output_onClose.fire(entitySystem, this);
    }

    private hitTop(entitySystem: EntitySystem): void {
        this.output_onFullyOpen.fire(entitySystem, this);
    }

    private hitBottom(entitySystem: EntitySystem): void {
        this.output_onFullyClosed.fire(entitySystem, this);
    }

    protected moveDone(entitySystem: EntitySystem): void {
        if (this.toggleState === ToggleState.GoingToTop)
            this.hitTop(entitySystem);
        else if (this.toggleState === ToggleState.GoingToBottom)
            this.hitBottom(entitySystem);
    }

    private input_close(entitySystem: EntitySystem): void {
        if (this.toggleState === ToggleState.Bottom)
            return;

        this.goToBottom(entitySystem);
    }

    private input_open(entitySystem: EntitySystem): void {
        if (this.toggleState === ToggleState.Top || this.toggleState === ToggleState.GoingToTop)
            return;

        if (this.locked)
            return;

        this.goToTop(entitySystem);
    }

    private input_toggle(entitySystem: EntitySystem): void {
        if (this.locked)
            return;

        if (this.toggleState === ToggleState.Top)
            this.goToTop(entitySystem);
        else if (this.toggleState === ToggleState.Bottom)
            this.goToBottom(entitySystem);
    }
}

class func_instance_io_proxy extends BaseEntity {
    public static classname = `func_instance_io_proxy`;

    private output_onProxyRelay: EntityOutput[] = [];

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        const numProxies = 30;
        for (let i = 1; i <= numProxies; i++) {
            const output = new EntityOutput();
            this.output_onProxyRelay.push(output);
            const ioName = `onproxyrelay${i}`;
            output.parse(this.entity[ioName]);
            this.registerInput(ioName, (entitySystem: EntitySystem) => {
                output.fire(entitySystem, this);
            });
        }
    }
}

class logic_auto extends BaseEntity {
    public static classname = `logic_auto`;

    private output_onMapSpawn = new EntityOutput();

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        this.output_onMapSpawn.parse(this.entity.onmapspawn);
    }

    public spawn(entitySystem: EntitySystem): void {
        super.spawn(entitySystem);

        this.output_onMapSpawn.fire(entitySystem, this);
    }
}

class logic_relay extends BaseEntity {
    public static classname = `logic_relay`;

    private output_onTrigger = new EntityOutput();

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        this.output_onTrigger.parse(this.entity.ontrigger);
        this.registerInput('trigger', this.input_trigger.bind(this));
    }

    private input_trigger(entitySystem: EntitySystem): void {
        this.output_onTrigger.fire(entitySystem, this);
    }
}


class logic_timer extends BaseEntity {
    public static classname = `logic_timer`;

    private refiretime: number = 0;
    private nextFireTime: number = 0;
    private useRandomTime: boolean = false;
    private lowerRandomBound: number = 0;
    private upperRandomBound: number = 0;

    private output_onTimer = new EntityOutput();

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        this.output_onTimer.parse(this.entity.ontimer);
        this.refiretime = Number(fallbackUndefined(this.entity.refiretime, '5'));
        this.useRandomTime = fallbackUndefined(this.entity.userandomtime, '0') !== '0';
        this.lowerRandomBound = Number(fallbackUndefined(this.entity.lowerrandombound, '0'));
        this.upperRandomBound = Number(fallbackUndefined(this.entity.upperrandombound, '5'));
    }

    private reset(entitySystem: EntitySystem): void {
        if (this.useRandomTime)
            this.refiretime = randomRange(this.lowerRandomBound, this.upperRandomBound);
        this.nextFireTime = entitySystem.currentTime + this.refiretime;
    }

    public movement(entitySystem: EntitySystem, renderContext: SourceRenderContext): void {
        super.movement(entitySystem, renderContext);

        if (!this.enabled)
            return;

        if (entitySystem.currentTime >= this.nextFireTime) {
            this.output_onTimer.fire(entitySystem, this);
            this.reset(entitySystem);
        }
    }
}

class math_counter extends BaseEntity {
    public static classname = `math_counter`;

    private min = 0;
    private max = 0;
    private value = 0;

    private minEdgeState: boolean = false;
    private maxEdgeState: boolean = false;

    private output_outValue = new EntityOutput();
    private output_onHitMin = new EntityOutput();
    private output_onHitMax = new EntityOutput();

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        this.output_outValue.parse(this.entity.outvalue);
        this.output_onHitMin.parse(this.entity.onhitmin);
        this.output_onHitMax.parse(this.entity.onhitmax);
        this.registerInput('add', this.input_add.bind(this));
        this.registerInput('subtract', this.input_subtract.bind(this));
        this.registerInput('setvalue', this.input_setvalue.bind(this));
        this.registerInput('setvaluenofire', this.input_setvaluenofire.bind(this));

        this.value = Number(fallbackUndefined(this.entity.startvalue, '0'));
        this.min = Number(fallbackUndefined(this.entity.min, '0'));
        this.max = Number(fallbackUndefined(this.entity.max, '0'));
    }

    private input_add(entitySystem: EntitySystem, value: string): void {
        const num = Number(value);
        this.updateValue(entitySystem, this.value + num);
    }

    private input_subtract(entitySystem: EntitySystem, value: string): void {
        const num = Number(value);
        this.updateValue(entitySystem, this.value - num);
    }

    private input_setvalue(entitySystem: EntitySystem, value: string): void {
        const num = Number(value);
        this.updateValue(entitySystem, num);
    }

    private input_setvaluenofire(entitySystem: EntitySystem, value: string): void {
        let num = Number(value);
        if (this.min !== 0 || this.max !== 0)
            num = clamp(num, this.min, this.max);
        this.value = num;
    }

    private updateValue(entitySystem: EntitySystem, v: number): void {
        this.value = v;

        if (this.max !== 0) {
            if (this.value >= this.max) {
                this.value = this.max;
                if (!this.maxEdgeState) {
                    this.output_onHitMax.fire(entitySystem, this);
                    this.maxEdgeState = true;
                }
            } else {
                this.maxEdgeState = false;
            }
        }

        if (this.min !== 0) {
            if (this.value <= this.min) {
                this.value = this.min;
                if (!this.minEdgeState) {
                    this.output_onHitMin.fire(entitySystem, this);
                    this.minEdgeState = true;
                }
            } else {
                this.minEdgeState = false;
            }
        }

        this.output_outValue.fire(entitySystem, this);
    }
}

class trigger_multiple extends BaseEntity {
    public static classname = `trigger_multiple`;

    private isPlayerTouching = false;

    private output_onTrigger = new EntityOutput();
    private output_onStartTouch = new EntityOutput();
    private output_onEndTouch = new EntityOutput();
    private output_onEndTouchAll = new EntityOutput();

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        this.output_onTrigger.parse(this.entity.ontrigger);
        this.output_onStartTouch.parse(this.entity.onstarttouch);
        this.output_onEndTouch.parse(this.entity.onendtouch);
        this.output_onEndTouchAll.parse(this.entity.onendtouchall);

        this.visible = false;
    }

    private getAABB(): AABB | null {
        if (this.modelBSP !== null)
            return this.modelBSP.model.bbox;
        else if (this.modelStudio !== null)
            return this.modelStudio.modelData.bbox;
        else
            return null;
    }

    protected onTouch(entitySystem: EntitySystem): void {
        this.output_onTrigger.fire(entitySystem, this);
        this.output_onStartTouch.fire(entitySystem, this);
    }

    protected onUnTouch(entitySystem: EntitySystem): void {
        this.output_onEndTouch.fire(entitySystem, this);
        this.output_onEndTouchAll.fire(entitySystem, this);
    }

    public movement(entitySystem: EntitySystem, renderContext: SourceRenderContext): void {
        super.movement(entitySystem, renderContext);

        const aabb = this.getAABB();
        const modelMatrix = this.getModelMatrix();
        if (aabb !== null && modelMatrix !== null) {
            // Test if the "player" (camera) is inside N units from our AABB.
            mat4.invert(scratchMat4a, modelMatrix);
            transformVec3Mat4w1(scratchVec3a, scratchMat4a, renderContext.currentView.cameraPos);

            const playerSize = 24;
            const isPlayerTouching = aabb.containsSphere(scratchVec3a, playerSize);

            if (this.isPlayerTouching !== isPlayerTouching) {
                this.isPlayerTouching = isPlayerTouching;

                if (this.enabled) {
                    if (this.isPlayerTouching)
                        this.onTouch(entitySystem);
                    else
                        this.onUnTouch(entitySystem);
                }
            }

            if (renderContext.showTriggerDebug) {
                const color = this.enabled ? (isPlayerTouching ? Green : Magenta) : Cyan;
                drawWorldSpaceAABB(getDebugOverlayCanvas2D(), renderContext.currentView.clipFromWorldMatrix, aabb, modelMatrix, color);

                getMatrixTranslation(scratchVec3a, modelMatrix);
                drawWorldSpaceText(getDebugOverlayCanvas2D(), renderContext.currentView.clipFromWorldMatrix, scratchVec3a, this.entity.targetname, 0, color, { align: 'center' });
            }
        }
    }
}

class trigger_once extends trigger_multiple {
    public static classname = `trigger_once`;

    protected onUnTouch(entitySystem: EntitySystem): void {
        super.onUnTouch(entitySystem);
        this.remove();
    }
}

class env_texturetoggle extends BaseEntity {
    public static classname = `env_texturetoggle`;

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        this.registerInput('settextureindex', this.input_settextureindex.bind(this));
        this.registerInput('incrementtextureindex', this.input_incrementtextureindex.bind(this));
    }

    private input_settextureindex(entitySystem: EntitySystem, value: string): void {
        const valueNum = Number(value);
        if (Number.isNaN(valueNum))
            return;

        for (let i = 0; i < entitySystem.entities.length; i++) {
            const entity = entitySystem.entities[i];
            if (!entitySystem.entityMatchesTargetName(entity, this.entity.target))
                continue;

            const materialParams = entity.materialParams;
            if (materialParams !== null)
                materialParams.textureFrameIndex = valueNum;
        }
    }

    private input_incrementtextureindex(entitySystem: EntitySystem): void {
        for (let i = 0; i < entitySystem.entities.length; i++) {
            const entity = entitySystem.entities[i];
            if (!entitySystem.entityMatchesTargetName(entity, this.entity.target))
                continue;

            const materialParams = entity.materialParams;
            if (materialParams !== null)
                materialParams.textureFrameIndex++;
        }
    }
}

function findMaterialOnEntity(entity: BaseEntity, materialName: string): BaseMaterial | null {
    if (entity.modelBSP !== null)
        return entity.modelBSP.findMaterial(materialName);
    // TODO(jstpierre): modelStudio? Is it possible?
    return null;
}

class material_modify_control extends BaseEntity {
    public static classname = `material_modify_control`;

    private materialname: string;
    private materialvar: ParameterReference;
    private value: number | null = null;

    private lerpValid = false;
    private lerpStartValue = -1;
    private lerpEndValue = -1;
    private lerpStartTime = -1;
    private lerpEndTime = -1;

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        this.materialname = fallbackUndefined(this.entity.materialname, '').toLowerCase();
        this.materialvar = new ParameterReference(this.entity.materialvar, null, false);

        this.registerInput('setmaterialvar', this.input_setmaterialvar.bind(this));
        this.registerInput('startfloatlerp', this.input_startfloatlerp.bind(this));
    }

    private input_setmaterialvar(entitySystem: EntitySystem, value: string): void {
        this.value = Number(value);
    }

    private input_startfloatlerp(entitySystem: EntitySystem, value: string): void {
        const [startValue, endValue, duration, loop] = value.split(' ');

        this.lerpValid = true;
        this.lerpStartValue = Number(startValue);
        this.lerpEndValue = Number(endValue);
        this.lerpStartTime = entitySystem.currentTime;
        this.lerpEndTime = this.lerpStartTime + Number(duration);
    }

    private syncValue(): void {
        if (this.value === null)
            return;

        const target = this.parentEntity;
        if (target === null)
            return;

        const materialInstance = findMaterialOnEntity(target, this.materialname);
        if (materialInstance === null)
            return;

        paramSetNum(materialInstance.param, this.materialvar, this.value);
        this.value = null;
    }

    public movement(entitySystem: EntitySystem, renderContext: SourceRenderContext): void {
        super.movement(entitySystem, renderContext);

        if (this.lerpValid) {
            let time = invlerp(this.lerpStartTime, this.lerpEndTime, entitySystem.currentTime);

            if (time > 1.0) {
                time = 1.0;
                this.lerpValid = false;
            }

            this.value = lerp(this.lerpStartValue, this.lerpEndValue, time);
        }

        this.syncValue();
    }
}

class color_correction extends BaseEntity {
    public static classname = `color_correction`;

    private minfalloff: number;
    private maxfalloff: number;
    private maxweight: number;
    private filename: string;
    private layer: Uint8Array | null = null;
    private weightOverride = -1;

    constructor(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity) {
        super(entitySystem, renderContext, bspRenderer, entity);

        this.filename = fallbackUndefined(this.entity.filename, '').toLowerCase();
        this.maxweight = Number(fallbackUndefined(this.entity.maxweight, '1'));
        this.minfalloff = Number(fallbackUndefined(this.entity.minfalloff, '-1'));
        this.maxfalloff = Number(fallbackUndefined(this.entity.maxfalloff, '-1'));

        this.fetchLUT(renderContext);
    }

    private async fetchLUT(renderContext: SourceRenderContext) {
        const lutData = await renderContext.filesystem.fetchFileData(this.filename);
        if (lutData === null)
            return;

        this.layer = lutData.createTypedArray(Uint8Array);
        renderContext.colorCorrection.addLayer(this.layer);
    }

    private calcWeight(renderContext: SourceRenderContext): number {
        if (this.weightOverride >= 0.0)
            return this.weightOverride;

        if (!this.enabled)
            return 0.0;

        this.getAbsOrigin(scratchVec3a);
        if (this.minfalloff >= 0 && this.maxfalloff >= 0 && this.minfalloff !== this.maxfalloff) {
            const dist = vec3.distance(renderContext.currentView.cameraPos, scratchVec3a);
            return saturate(invlerp(this.minfalloff, this.maxfalloff, dist));
        } else {
            return 1.0;
        }
    }

    public movement(entitySystem: EntitySystem, renderContext: SourceRenderContext): void {
        super.movement(entitySystem, renderContext);

        if (this.layer === null)
            return;

        const weight = this.calcWeight(renderContext);
        renderContext.colorCorrection.setLayerWeight(this.layer, weight);
    }
}

interface EntityFactory {
    new(entitySystem: EntitySystem, renderContext: SourceRenderContext, bspRenderer: BSPRenderer, entity: BSPEntity): BaseEntity;
    classname: string;
}

interface QueuedOutputEvent {
    activator: BaseEntity;
    triggerTime: number;
    action: EntityOutputAction;
    value: string;
}

export class EntitySystem {
    public classname = new Map<string, EntityFactory>();
    public entities: BaseEntity[] = [];
    public currentTime = 0;
    public debugger = new EntityMessageDebugger();
    private outputQueue: QueuedOutputEvent[] = [];

    constructor() {
        this.registerDefaultFactories();
    }

    private registerDefaultFactories(): void {
        this.registerFactory(sky_camera);
        this.registerFactory(water_lod_control);
        this.registerFactory(func_movelinear);
        this.registerFactory(func_door);
        this.registerFactory(func_instance_io_proxy);
        this.registerFactory(logic_auto);
        this.registerFactory(logic_relay);
        this.registerFactory(logic_timer);
        this.registerFactory(math_counter);
        this.registerFactory(trigger_multiple);
        this.registerFactory(trigger_once);
        this.registerFactory(env_texturetoggle);
        this.registerFactory(material_modify_control);
        this.registerFactory(color_correction);
    }

    public registerFactory(factory: EntityFactory): void {
        this.classname.set(factory.classname, factory);
    }

    public entityMatchesTargetName(entity: BaseEntity, targetName: string): boolean {
        if (entity.targetName === targetName)
            return true;

        // TODO(jstpierre): Support multicast / wildcard target names
        return false;
    }

    public queueEntityOutputAction(action: EntityOutputAction, activator: BaseEntity, value: string): void {
        if (action.parameterOverride !== '')
            value = action.parameterOverride;

        const triggerTime = this.currentTime + action.delay;
        this.outputQueue.push({ activator, action, triggerTime, value });
    }

    public findEntityByTargetName(targetName: string): BaseEntity | null {
        for (let i = 0; i < this.entities.length; i++)
            if (this.entities[i].targetName === targetName)
                return this.entities[i];
        return null;
    }

    private fireInput(target: BaseEntity, event: QueuedOutputEvent): void {
        this.debugger.fireInput(target, event, this.currentTime);

        target.fireInput(this, event.action.inputName, event.value);
    }

    private fireEntityOutputAction(event: QueuedOutputEvent): boolean {
        if (this.currentTime < event.triggerTime)
            return false;

        for (let i = 0; i < this.entities.length; i++) {
            const target = this.entities[i];
            if (!this.entityMatchesTargetName(target, event.action.targetName))
                continue;
            this.fireInput(target, event);
        }

        return true;
    }

    private processOutputQueue(): void {
        for (let i = 0; i < this.outputQueue.length; i++)
            if (this.fireEntityOutputAction(this.outputQueue[i]))
                this.outputQueue.splice(i--, 1);
    }

    public movement(renderContext: SourceRenderContext): void {
        this.processOutputQueue();
        this.debugger.movement(renderContext);

        for (let i = 0; i < this.entities.length; i++)
            if (this.entities[i].alive)
                this.entities[i].movement(this, renderContext);

        this.currentTime = renderContext.globalTime;
    }

    private spawn(): void {
        for (let i = 0; i < this.entities.length; i++)
            this.entities[i].spawn(this);
    }

    private createEntity(renderContext: SourceRenderContext, renderer: BSPRenderer, bspEntity: BSPEntity): void {
        const factory = this.classname.get(bspEntity.classname);

        let entity: BaseEntity;
        if (factory !== undefined) {
            entity = new factory(this, renderContext, renderer, bspEntity);
        } else {
            entity = new BaseEntity(this, renderContext, renderer, bspEntity);
        }

        this.entities.push(entity);
    }

    public createEntities(renderContext: SourceRenderContext, renderer: BSPRenderer, entities: BSPEntity[]): void {
        for (let i = 0; i < entities.length; i++)
            this.createEntity(renderContext, renderer, entities[i]);
        this.spawn();
    }
}

interface EntityMessageDebuggerItem {
    target: BaseEntity;
    event: QueuedOutputEvent;
    time: number;
}

class EntityMessageDebugger {
    private messages: EntityMessageDebuggerItem[] = [];
    public capture = IS_DEVELOPMENT;
    public draw = IS_DEVELOPMENT;

    public fireInput(target: BaseEntity, event: QueuedOutputEvent, time: number): void {
        if (!this.capture)
            return;

        this.messages.unshift({ target, event, time });
    }

    // Show for 1 second, then fade it out for 1 second.

    public timeFull = 1;
    public timeFade = 1;
    public movement(renderContext: SourceRenderContext): void {
        if (!this.draw)
            return;

        const activatorColor = colorNewCopy(Green);
        const targetColor = colorNewCopy(Red);
        const lineColor = colorNewCopy(White);

        const timeTotal = this.timeFade + this.timeFull;
        for (let i = 0; i < this.messages.length; i++) {
            const message = this.messages[i];
            const timeDelta = renderContext.globalTime - message.time;

            if (timeDelta > timeTotal) {
                this.messages.length = i;
                break;
            }

            const alpha = saturate(invlerp(timeTotal, this.timeFull, timeDelta));
            activatorColor.a = alpha;
            targetColor.a = alpha;
            lineColor.a = alpha;

            const activator = message.event.activator, target = message.target;
            const ctx = getDebugOverlayCanvas2D();

            activator.getAbsOrigin(scratchVec3a);
            target.getAbsOrigin(scratchVec3b);
            drawWorldSpacePoint(ctx, renderContext.currentView.clipFromWorldMatrix, scratchVec3a, activatorColor, 6);
            drawWorldSpacePoint(ctx, renderContext.currentView.clipFromWorldMatrix, scratchVec3b, targetColor, 6);
            drawWorldSpaceLine(ctx, renderContext.currentView.clipFromWorldMatrix, scratchVec3a, scratchVec3b, lineColor, 3);
            drawWorldSpaceText(ctx, renderContext.currentView.clipFromWorldMatrix, scratchVec3b, message.event.action.inputName, 6, lineColor, { outline: 3, font: '8pt monospace' });
        }
    }
}
