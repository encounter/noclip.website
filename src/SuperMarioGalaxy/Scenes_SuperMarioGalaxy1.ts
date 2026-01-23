
import * as Viewer from '../viewer.js';
import { SMGSceneDescBase, ModelCache, SceneObjHolder, SMGRenderer } from "./Main.js";
import { JMapInfoIter, createCsvParser } from './JMapInfo.js';
import { JKRArchive } from '../Common/JSYSTEM/JKRArchive.js';
import { NameObj, MovementType, GameBits } from './NameObj.js';
import { connectToScene, getRailTotalLength, vecKillElement } from './ActorUtil.js';
import { randomRangeInt } from '../MathHelpers.js';
import { randomRangeFloat } from '../MathHelpers.js';
import { vec3, mat4 } from 'gl-matrix';
import { TicoRail } from './Actors/NPC.js';
import { SceneContext } from '../SceneBase.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';

class SMG1SceneDesc extends SMGSceneDescBase {
    public override pathBase: string = `SuperMarioGalaxy`;
    public override gameBit = GameBits.SMG1;
    public getLightData(modelCache: ModelCache): JMapInfoIter {
        const lightDataRarc = modelCache.getArchive(`ObjectData/LightData.arc`)!;
        return createCsvParser(lightDataRarc.findFileData(`LightData.bcsv`)!);
    }
    public getZoneLightData(modelCache: ModelCache, zoneName: string): JMapInfoIter {
        const lightDataRarc = modelCache.getArchive(`ObjectData/LightData.arc`)!;
        return createCsvParser(lightDataRarc.findFileData(`Light${zoneName}.bcsv`)!);
    }
    public getZoneMapArchive(modelCache: ModelCache, zoneName: string): JKRArchive {
        return modelCache.getArchive(`StageData/${zoneName}.arc`)!;
    }
    public getObjNameTable(modelCache: ModelCache): JMapInfoIter {
        const arc = modelCache.getArchive(`StageData/ObjNameTable.arc`)!;
        return createCsvParser(arc.findFileData(`ObjNameTable.tbl`)!);
    }
    public requestGlobalArchives(modelCache: ModelCache): void {
        modelCache.requestArchiveData(`ObjectData/LightData.arc`);
        modelCache.requestArchiveData(`StageData/ObjNameTable.arc`);
    }
    public requestZoneArchives(modelCache: ModelCache, zoneName: string): void {
        modelCache.requestArchiveData(`StageData/${zoneName}.arc`);
    }
}

function explerp(dst: vec3, target: vec3, k: number): void {
    dst[0] += (target[0] - dst[0]) * k;
    dst[1] += (target[1] - dst[1]) * k;
    dst[2] += (target[2] - dst[2]) * k;
}

const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();
const scratchVec3c = vec3.create();
class DayInTheLifeOfALumaController extends NameObj {
    private ticos: TicoRail[] = [];
    private ticoIndex: number = -1;
    private currentZoom: number;
    private switchCounter: number;
    private cameraCenter = vec3.create();
    private cameraEye = vec3.create();
    private cameraK = 1/8;

    constructor(sceneObjHolder: SceneObjHolder) {
        super(sceneObjHolder, 'DayInTheLifeOfALumaController');
        connectToScene(sceneObjHolder, this, MovementType.MapObj, -1, -1, -1);
    }

    private pickNewTico(): void {
        while (true) {
            this.ticoIndex = randomRangeInt(0, this.ticos.length);
            const tico = this.ticos[this.ticoIndex];

            if (!tico.visibleAlive || !tico.visibleScenario)
                continue;

            // Never picked a stopped Tico.
            if (tico.isStopped(0))
                continue;

            break;
        }

        const tico = this.ticos[this.ticoIndex];
        const isShortRail = getRailTotalLength(tico) < 10000;
        this.currentZoom = isShortRail ? randomRangeFloat(500, 2500) : randomRangeFloat(1000, 3500);
        this.switchCounter = isShortRail ? 2000 : -1;
    }

    public override initAfterPlacement(sceneObjHolder: SceneObjHolder): void {
        super.initAfterPlacement(sceneObjHolder);
        this.ticos = sceneObjHolder.nameObjHolder.nameObjs.filter((obj) => obj.name === 'TicoRail') as TicoRail[];
        this.pickNewTico();

        this.camera(1.0);
    }

    private camera(k: number = this.cameraK): void {
        const tico = this.ticos[this.ticoIndex];

        // Camera hax
        vec3.copy(scratchVec3a, tico.direction);
        vec3.set(scratchVec3b, 0, 1, 0);

        // XZ plane
        vecKillElement(scratchVec3c, scratchVec3a, scratchVec3b);
        // Jam the direction vector by this a ton to smooth out the Y axis.
        vec3.scaleAndAdd(scratchVec3a, scratchVec3a, scratchVec3c, 1);
        vec3.normalize(scratchVec3a, scratchVec3a);

        vec3.scaleAndAdd(scratchVec3a, tico.translation, scratchVec3a, -this.currentZoom);
        scratchVec3a[1] += 500;

        explerp(this.cameraEye, scratchVec3a, k);
        explerp(this.cameraCenter, tico.translation, k);
    }

    private tryPickNewTico(deltaTimeFrames: number): void {
        const tico = this.ticos[this.ticoIndex];

        // If the Tico isn't visible due to scenario reasons, force a new Tico.
        if (!tico.visibleScenario || !tico.visibleAlive)
            this.pickNewTico();

        if (tico.isStopped(0)) {
            // Each frame that we're stopped, there's a 1 in 200 chance that we switch.
            const rnd = randomRangeInt(0, 200);
            if (rnd === 0)
                this.pickNewTico();
        }

        // The ticos in the middle will never stop because of how they're set up.
        if (this.switchCounter >= 0) {
            this.switchCounter -= deltaTimeFrames;
            if (this.switchCounter <= 0)
                this.pickNewTico();
        }
    }

    public override movement(sceneObjHolder: SceneObjHolder): void {
        super.movement(sceneObjHolder);

        if (sceneObjHolder.inputManager.isKeyDownEventTriggered('Space'))
            this.pickNewTico();
        else
            this.tryPickNewTico(sceneObjHolder.deltaTimeFrames);
        this.camera();

        const camera = sceneObjHolder.viewerInput.camera;
        mat4.targetTo(camera.worldMatrix, this.cameraEye, this.cameraCenter, scratchVec3b);
        camera.worldMatrixUpdated();
    }
}

class DayInTheLifeOfALuma extends SMG1SceneDesc {
    private controller: DayInTheLifeOfALumaController;

    public override placeExtra(sceneObjHolder: SceneObjHolder): void {
        this.controller = new DayInTheLifeOfALumaController(sceneObjHolder);
    }

    protected override setup(context: SceneContext, renderer: SMGRenderer): void {
        context.inputManager.isMouseEnabled = false;
    }
}

const scenarioOverrideRegex = /(\d+)$/;

export function createScene(device: GfxDevice, context: SceneContext, id: string): Promise<Viewer.SceneGfx> {
    if (id === 'DayInTheLifeOfALuma') {
        return new DayInTheLifeOfALuma(id).createScene(device, context);
    }

    let scenarioOverride: number | null = null;
    let galaxyName = id;

    const match = scenarioOverrideRegex.exec(id);
    if (match !== null) {
        scenarioOverride = parseInt(match[1]);
        galaxyName = id.slice(0, match.index);
    }

    return new SMG1SceneDesc(galaxyName, scenarioOverride).createScene(device, context);
}
