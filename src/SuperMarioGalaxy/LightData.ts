
import { vec3 } from "gl-matrix";
import { colorNew, colorCopy, colorFromRGBA, Color } from "../Color";
import { Camera } from "../Camera";
import { Light } from "../gx/gx_material";
import { BMDModelInstance } from "../j3d/render";
import { JMapInfoIter, getJMapInfoBool } from "./JMapInfo";
import { LightType } from "./DrawBuffer";
import { SceneObjHolder } from "./Main";
import { ColorKind } from "../gx/gx_render";
import { LiveActor } from "./LiveActor";
import { assertExists, fallback } from "../util";

function getValueColor(color: Color, infoIter: JMapInfoIter, prefix: string): void {
    const colorR = fallback(infoIter.getValueNumber(`${prefix}R`), 0) / 0xFF;
    const colorG = fallback(infoIter.getValueNumber(`${prefix}G`), 0) / 0xFF;
    const colorB = fallback(infoIter.getValueNumber(`${prefix}B`), 0) / 0xFF;
    const colorA = fallback(infoIter.getValueNumber(`${prefix}A`), 0) / 0xFF;
    colorFromRGBA(color, colorR, colorG, colorB, colorA);
}

class LightInfo {
    public Position = vec3.create();
    public Color = colorNew(1, 1, 1, 1);
    public FollowCamera: boolean = false;

    constructor() {
    }

    public setFromLightInfo(infoIter: JMapInfoIter, prefix: string): void {
        getValueColor(this.Color, infoIter, `${prefix}Color`);

        const posX = fallback(infoIter.getValueNumber(`${prefix}PosX`), 0);
        const posY = fallback(infoIter.getValueNumber(`${prefix}PosY`), 0);
        const posZ = fallback(infoIter.getValueNumber(`${prefix}PosZ`), 0);
        vec3.set(this.Position, posX, posY, posZ);

        this.FollowCamera = infoIter.getValueNumber(`${prefix}FollowCamera`) !== 0;
    }

    public setLight(dst: Light, camera: Camera): void {
        if (this.FollowCamera) {
            vec3.transformMat4(dst.Position, this.Position, camera.worldMatrix);
        } else {
            vec3.copy(dst.Position, this.Position);
        }

        vec3.set(dst.Direction, 1, 0, 0);
        colorCopy(dst.Color, this.Color);
        vec3.set(dst.CosAtten, 1, 0, 0);
        vec3.set(dst.DistAtten, 1, 0, 0);
    }
}

class ActorLightInfo {
    public Light0 = new LightInfo();
    public Light1 = new LightInfo();
    public Alpha2: number = 0.0;
    public Ambient = colorNew(1, 1, 1, 1);

    constructor() {
    }

    public setFromLightInfo(infoIter: JMapInfoIter, prefix: string): void {
        this.Light0.setFromLightInfo(infoIter, `${prefix}Light0`);
        this.Light1.setFromLightInfo(infoIter, `${prefix}Light1`);
        getValueColor(this.Ambient, infoIter, `${prefix}Ambient`);
        this.Alpha2 = fallback(infoIter.getValueNumber(`${prefix}Alpha2`), 0) / 0xFF;
    }

    public setOnModelInstance(modelInstance: BMDModelInstance, camera: Camera, setAmbient: boolean): void {
        this.Light0.setLight(modelInstance.getGXLightReference(0), camera);
        this.Light1.setLight(modelInstance.getGXLightReference(1), camera);

        const light2 = modelInstance.getGXLightReference(2);
        vec3.set(light2.Position, 0, 0, 0);
        vec3.set(light2.Direction, 0, -1, 0);
        vec3.set(light2.CosAtten, 1, 0, 0);
        vec3.set(light2.DistAtten, 1, 0, 0);
        colorFromRGBA(light2.Color, 0, 0, 0, this.Alpha2);

        if (setAmbient)
            modelInstance.setColorOverride(ColorKind.AMB0, this.Ambient, true);
    }
}

export class AreaLightInfo {
    public AreaLightName: string;
    public Interpolate: boolean;
    public Player = new ActorLightInfo();
    public Strong = new ActorLightInfo();
    public Weak = new ActorLightInfo();
    public Planet = new ActorLightInfo();

    constructor(infoIter: JMapInfoIter) {
        this.AreaLightName = assertExists(infoIter.getValueString('AreaLightName'));
        this.Interpolate = getJMapInfoBool(fallback(infoIter.getValueNumberNoInit('Interpolate'), -1));
        this.Player.setFromLightInfo(infoIter, 'Player');
        this.Strong.setFromLightInfo(infoIter, 'Strong');
        this.Weak.setFromLightInfo(infoIter, 'Weak');
        this.Planet.setFromLightInfo(infoIter, 'Planet');
    }

    public getActorLightInfo(lightType: LightType): ActorLightInfo {
        if (lightType === LightType.Player)
            return this.Player;
        else if (lightType === LightType.Strong)
            return this.Strong;
        else if (lightType === LightType.Weak)
            return this.Weak;
        else if (lightType === LightType.Planet)
            return this.Planet;
        else
            throw "whoops";
    }
}

export class ActorLightCtrl {
    public currentAreaLight: AreaLightInfo | null = null;
    private currentActorLight = new ActorLightInfo();

    constructor(private assocActor: LiveActor, public lightType: LightType = LightType.None) {
    }

    public initActorLightInfo(sceneObjHolder: SceneObjHolder): void {
        if (this.lightType !== LightType.None)
            return;
        sceneObjHolder.sceneNameObjListExecutor.findLightInfo(this.assocActor);
    }

    private setCurrentAreaLight(): void {
    }

    public setAreaLightFromZoneAndId(sceneObjHolder: SceneObjHolder, zoneId: number, lightId: number): void {
        this.currentAreaLight = sceneObjHolder.lightDataHolder.findAreaLightFromZoneAndId(sceneObjHolder, zoneId, lightId);
    }

    public setAreaLightFromName(sceneObjHolder: SceneObjHolder, name: string): void {
        this.currentAreaLight = sceneObjHolder.lightDataHolder.findAreaLight(name);
    }

    public setDefaultAreaLight(sceneObjHolder: SceneObjHolder): void {
        this.currentAreaLight = sceneObjHolder.lightDataHolder.findDefaultAreaLight(sceneObjHolder);
    }

    public update(): void {
        // Do nothing for now
    }

    public getActorLight(): ActorLightInfo | null {
        if (this.currentAreaLight !== null)
            return this.getTargetActorLight(this.currentAreaLight);
        else
            return null;
    }

    public getTargetActorLight(areaLight: AreaLightInfo): ActorLightInfo | null {
        return areaLight.getActorLightInfo(this.lightType);
    }
}

class LightZoneInfo {
    private lightIDToAreaLightName = new Map<number, string>();

    constructor(public zoneId: number, public zoneName: string, infoIter: JMapInfoIter) {
        for (let i = 0; i < infoIter.getNumRecords(); i++) {
            infoIter.setRecord(i);
            const lightID = fallback(infoIter.getValueNumber('LightID'), -1);
            const areaLightName = assertExists(infoIter.getValueString('AreaLightName'));
            this.lightIDToAreaLightName.set(lightID, areaLightName);
        }
    }

    public getAreaLightName(lightID: number): string {
        return this.lightIDToAreaLightName.get(lightID)!;
    }
}

export class LightDataHolder {
    public areaLightInfos: AreaLightInfo[] = [];
    public zoneInfos: LightZoneInfo[] = [];

    constructor(lightData: JMapInfoIter) {
        for (let i = 0; i < lightData.getNumRecords(); i++) {
            lightData.setRecord(i);
            this.areaLightInfos.push(new AreaLightInfo(lightData));
        }
    }

    private ensureZoneInfo(sceneObjHolder: SceneObjHolder, zoneId: number): LightZoneInfo {
        for (let i = 0; i < this.zoneInfos.length; i++)
            if (this.zoneInfos[i].zoneId === zoneId)
                return this.zoneInfos[i];
        const zoneName = sceneObjHolder.scenarioData.zoneNames[zoneId];
        const zoneLightData = sceneObjHolder.sceneDesc.getZoneLightData(sceneObjHolder.modelCache, zoneName);
        const zoneInfo = new LightZoneInfo(zoneId, zoneName, zoneLightData);
        this.zoneInfos.push(zoneInfo);
        return zoneInfo;
    }

    public getAreaLightName(sceneObjHolder: SceneObjHolder, zoneId: number, lightId: number): string {
        return this.ensureZoneInfo(sceneObjHolder, zoneId).getAreaLightName(lightId);
    }

    public findAreaLight(areaLightName: string): AreaLightInfo | null {
        for (let i = 0; i < this.areaLightInfos.length; i++)
            if (this.areaLightInfos[i].AreaLightName === areaLightName)
                return this.areaLightInfos[i];
        return null;
    }

    public findDefaultAreaLight(sceneObjHolder: SceneObjHolder): AreaLightInfo {
        return this.findAreaLightFromZoneAndId(sceneObjHolder, 0, -1);
    }

    public findAreaLightFromZoneAndId(sceneObjHolder: SceneObjHolder, zoneId: number, lightId: number): AreaLightInfo {
        const areaLightName = this.getAreaLightName(sceneObjHolder, zoneId, lightId);
        return assertExists(this.findAreaLight(areaLightName));
    }
}
