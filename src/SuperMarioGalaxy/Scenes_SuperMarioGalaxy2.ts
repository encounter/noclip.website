
import * as Viewer from '../viewer.js';
import { SMGSceneDescBase, ModelCache } from "./Main.js";
import { JMapInfoIter, createCsvParser } from './JMapInfo.js';
import { JKRArchive } from '../Common/JSYSTEM/JKRArchive.js';
import { GameBits } from './NameObj.js';
import type { SceneContext } from '../SceneBase.js';
import type { GfxDevice } from '../gfx/platform/GfxPlatform.js';

class SMG2SceneDesc extends SMGSceneDescBase {
    public override pathBase: string = `SuperMarioGalaxy2`;
    public override gameBit = GameBits.SMG2;
    public getLightData(modelCache: ModelCache): JMapInfoIter {
        const lightDataRarc = modelCache.getArchive(`LightData/LightData.arc`)!;
        return createCsvParser(lightDataRarc.findFileData(`LightData.bcsv`)!);
    }
    public getZoneLightData(modelCache: ModelCache, zoneName: string): JMapInfoIter {
        const lightDataRarc = modelCache.getArchive(`StageData/${zoneName}/${zoneName}Light.arc`)!;
        return createCsvParser(lightDataRarc.findFileData(`csv/${zoneName}Light.bcsv`)!);
    }
    public getZoneMapArchive(modelCache: ModelCache, zoneName: string): JKRArchive {
        return modelCache.getArchive(`StageData/${zoneName}/${zoneName}Map.arc`)!;
    }
    public getObjNameTable(modelCache: ModelCache): JMapInfoIter {
        const arc = modelCache.getArchive(`SystemData/ObjNameTable.arc`)!;
        return createCsvParser(arc.findFileData(`ObjNameTable.tbl`)!);
    }
    public requestGlobalArchives(modelCache: ModelCache): void {
        modelCache.requestArchiveData(`LightData/LightData.arc`);
        modelCache.requestArchiveData(`SystemData/ObjNameTable.arc`);
    }
    public requestZoneArchives(modelCache: ModelCache, zoneName: string): void {
        modelCache.requestArchiveData(`StageData/${zoneName}/${zoneName}Map.arc`);
        modelCache.requestArchiveData(`StageData/${zoneName}/${zoneName}Light.arc`);
        modelCache.requestArchiveData(`StageData/${zoneName}/${zoneName}Demo.arc`);
        if (zoneName.startsWith('WorldMap'))
            modelCache.requestObjectData(zoneName.slice(0, 10));
    }
}

const scenarioOverrideRegex = /(\d+)$/;

export function createScene(device: GfxDevice, context: SceneContext, id: string): Promise<Viewer.SceneGfx> {
    let scenarioOverride: number | null = null;
    let galaxyName = id;

    const match = scenarioOverrideRegex.exec(id);
    if (match !== null) {
        scenarioOverride = parseInt(match[1]);
        galaxyName = id.slice(0, match.index);
    }

    return new SMG2SceneDesc(galaxyName, scenarioOverride).createScene(device, context);
}
