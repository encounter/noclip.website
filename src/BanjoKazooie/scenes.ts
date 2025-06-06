
import * as Viewer from '../viewer';
import * as UI from '../ui';
import * as Geo from './geo';
import * as Flipbook from './flipbook'
import * as BYML from '../byml';

import { GfxDevice, GfxHostAccessPass, GfxRenderPass } from '../gfx/platform/GfxPlatform';
import { FakeTextureHolder, TextureHolder } from '../TextureHolder';
import { textureToCanvas, BKPass, GeometryRenderer, RenderData, AnimationFile, AnimationTrack, AnimationTrackType, AnimationKeyframe, BoneAnimator, FlipbookRenderer, GeometryData, FlipbookData, setSelectorValue } from './render';
import { mat4, vec3, vec4 } from 'gl-matrix';
import { transparentBlackFullClearRenderPassDescriptor, depthClearRenderPassDescriptor, BasicRenderTarget } from '../gfx/helpers/RenderTargetHelpers';
import { SceneContext } from '../SceneBase';
import { GfxRenderHelper } from '../gfx/render/GfxRenderGraph';
import { executeOnPass, makeSortKey, GfxRendererLayer } from '../gfx/render/GfxRenderer';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache';
import ArrayBufferSlice from '../ArrayBufferSlice';
import { assert, hexzero, assertExists, hexdump } from '../util';
import { DataFetcher } from '../DataFetcher';
import { MathConstants } from '../MathHelpers';

const pathBase = `BanjoKazooie`;

class BKRenderer implements Viewer.SceneGfx {
    public geoRenderers: GeometryRenderer[] = [];
    public flipbookRenderers: FlipbookRenderer[] = [];
    public geoDatas: RenderData[] = [];

    public renderTarget = new BasicRenderTarget();
    public renderHelper: GfxRenderHelper;

    constructor(device: GfxDevice, public textureHolder: TextureHolder<any>) {
        this.renderHelper = new GfxRenderHelper(device);
    }

    public createPanels(): UI.Panel[] {
        const renderHacksPanel = new UI.Panel();

        renderHacksPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderHacksPanel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');
        const enableCullingCheckbox = new UI.Checkbox('Enable Culling', true);
        enableCullingCheckbox.onchanged = () => {
            for (let i = 0; i < this.geoRenderers.length; i++)
                this.geoRenderers[i].setBackfaceCullingEnabled(enableCullingCheckbox.checked);
            for (let i = 0; i < this.flipbookRenderers.length; i++)
                this.flipbookRenderers[i].setBackfaceCullingEnabled(enableCullingCheckbox.checked);
        };
        renderHacksPanel.contents.appendChild(enableCullingCheckbox.elem);
        const enableVertexColorsCheckbox = new UI.Checkbox('Enable Vertex Colors', true);
        enableVertexColorsCheckbox.onchanged = () => {
            for (let i = 0; i < this.geoRenderers.length; i++)
                this.geoRenderers[i].setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
            for (let i = 0; i < this.flipbookRenderers.length; i++)
                this.flipbookRenderers[i].setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
        };
        renderHacksPanel.contents.appendChild(enableVertexColorsCheckbox.elem);
        const enableTextures = new UI.Checkbox('Enable Textures', true);
        enableTextures.onchanged = () => {
            for (let i = 0; i < this.geoRenderers.length; i++)
                this.geoRenderers[i].setTexturesEnabled(enableTextures.checked);
            for (let i = 0; i < this.flipbookRenderers.length; i++)
                this.flipbookRenderers[i].setTexturesEnabled(enableTextures.checked);
        };
        renderHacksPanel.contents.appendChild(enableTextures.elem);
        const enableMonochromeVertexColors = new UI.Checkbox('Grayscale Vertex Colors', false);
        enableMonochromeVertexColors.onchanged = () => {
            for (let i = 0; i < this.geoRenderers.length; i++)
                this.geoRenderers[i].setMonochromeVertexColorsEnabled(enableMonochromeVertexColors.checked);
            for (let i = 0; i < this.flipbookRenderers.length; i++)
                this.flipbookRenderers[i].setMonochromeVertexColorsEnabled(enableMonochromeVertexColors.checked);
        };
        renderHacksPanel.contents.appendChild(enableMonochromeVertexColors.elem);
        const enableAlphaVisualizer = new UI.Checkbox('Visualize Vertex Alpha', false);
        enableAlphaVisualizer.onchanged = () => {
            for (let i = 0; i < this.geoRenderers.length; i++)
                this.geoRenderers[i].setAlphaVisualizerEnabled(enableAlphaVisualizer.checked);
            for (let i = 0; i < this.flipbookRenderers.length; i++)
                this.flipbookRenderers[i].setAlphaVisualizerEnabled(enableAlphaVisualizer.checked);
        };
        renderHacksPanel.contents.appendChild(enableAlphaVisualizer.elem);

        return [renderHacksPanel];
    }

    public prepareToRender(device: GfxDevice, hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput): void {
        this.renderHelper.pushTemplateRenderInst();
        for (let i = 0; i < this.geoRenderers.length; i++)
            this.geoRenderers[i].prepareToRender(device, this.renderHelper.renderInstManager, viewerInput);
        for (let i = 0; i < this.flipbookRenderers.length; i++)
            this.flipbookRenderers[i].prepareToRender(device, this.renderHelper.renderInstManager, viewerInput);
        this.renderHelper.renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender(device, hostAccessPass);
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): GfxRenderPass {
        const hostAccessPass = device.createHostAccessPass();
        this.prepareToRender(device, hostAccessPass, viewerInput);
        device.submitPass(hostAccessPass);

        this.renderTarget.setParameters(device, viewerInput.backbufferWidth, viewerInput.backbufferHeight);
        const renderInstManager = this.renderHelper.renderInstManager;

        // First, render the skybox.
        const skyboxPassRenderer = this.renderTarget.createRenderPass(device, viewerInput.viewport, transparentBlackFullClearRenderPassDescriptor);
        executeOnPass(renderInstManager, device, skyboxPassRenderer, BKPass.SKYBOX);
        skyboxPassRenderer.endPass(null);
        device.submitPass(skyboxPassRenderer);
        // Now do main pass.
        const mainPassRenderer = this.renderTarget.createRenderPass(device, viewerInput.viewport, depthClearRenderPassDescriptor);
        executeOnPass(renderInstManager, device, mainPassRenderer, BKPass.MAIN);

        renderInstManager.resetRenderInsts();

        return mainPassRenderer;
    }

    public destroy(device: GfxDevice): void {
        this.renderTarget.destroy(device);
        this.renderHelper.destroy(device);
        for (let i = 0; i < this.geoDatas.length; i++)
            this.geoDatas[i].destroy(device);
        this.textureHolder.destroy(device);
    }
}

interface AnimationEntry {
    id: number;
    duration: number;
}

interface AnimationEntry {
    FileID: number;
    Duration: number;
}

interface ObjectLoadEntry {
    OtherID: number; // Not sure what this is...
    SpawnID: number;
    GeoFileID: number;
    AnimationTable: AnimationEntry[];
    AnimationStartIndex: number;
    Flags: number;
    Scale: number;
}

interface ObjectSetupData {
    ObjectSetupTable: ObjectLoadEntry[];
    Files: CRG1File[];
}

interface CRG1File {
    FileID: number;
    Data: ArrayBufferSlice;
}

interface CRG1Archive {
    Files: CRG1File[];
}

function findFileByID(archive: CRG1Archive, fileID: number): CRG1File | null {
    if (fileID === -1)
        return null;
    const file = archive.Files.find((file) => file.FileID === fileID);
    if (file === undefined)
        return null;
    return file;
}

// from switches starting at 30923c
const levelGeoSelectors = new Map<number, number[][]>([
    [0x01, [[1, 1], [2, 0]]], // end game value
    [0x12, [[1, 0], [2, 0], [5, 0]]], // variable, 0 or 1
    [0x14, [[5, 0]]], // variable, 0 or 1 (really complicated check)
    [0x1d, [[1, 0]]],

    // mumbo's huts
    [0x0e, [[1, 1], [5, 1]]],
    [0x47, [[1, 2], [5, 2]]],
    [0x48, [[1, 3], [5, 3]]],
    [0x30, [[1, 4], [5, 4]]],
    [0x4A, [[1, 5], [5, 5]]],
    [0x4B, [[1, 6], [5, 6]]],
    [0x4C, [[1, 7], [5, 7]]],
    [0x4D, [[1, 8], [5, 8]]],

    // light under nabnut's door
    [0x5E, [[1, 1], [2, 0]]],
    [0x5F, [[1, 1], [2, 0]]],
    [0x60, [[1, 1], [2, 0]]],
    [0x61, [[1, 0], [2, 1]]],

    // cutscenes?
    [0x7B, [[4, 0], [5, 0], [6, 0]]],
    [0x7C, [[5, 2]]],
    [0x81, [[4, 0], [5, 0], [6, 0]]],
    [0x82, [[4, 1], [5, 1], [6, 1]]],
    [0x83, [[4, 1], [5, 1], [6, 1]]],
    [0x84, [[4, 1], [5, 1], [6, 1]]],
    [0x88, [[1, 1], [2, 0]]],
    [0x89, [[5, 1]]],
    [0x8A, [[5, 1]]],

    [0x8C, [[5, 1]]],
    [0x91, [[5, 1]]],
    [0x93, [[4, 1], [5, 1], [6, 0]]], // last is variable, 0 or 1
]);

function setLevelGeoSelector(geo: GeometryRenderer, id: number) {
    const valueList = levelGeoSelectors.get(id);
    if (valueList === undefined)
        return;
    for (let i = 0; i < valueList.length; i++)
        setSelectorValue(geo.selectorState, valueList[i][0], valueList[i][1]);
}

function parseAnimationFile(buffer: ArrayBufferSlice): AnimationFile {
    const view = buffer.createDataView();

    const startFrame = view.getUint16(0x00);
    const endFrame = view.getUint16(0x02);
    const trackCount = view.getUint16(0x04);
    assert(view.getUint16(0x06) === 0);

    let trackTableIdx = 0x08;
    const tracks: AnimationTrack[] = [];
    for (let i = 0; i < trackCount; i++) {
        const w = view.getUint16(trackTableIdx + 0x00);
        const boneID = (w >>> 4);
        const trackType: AnimationTrackType = (w & 0x0F);
        const keyframeCount = view.getUint16(trackTableIdx + 0x02);

        trackTableIdx += 0x04;
        const keyframes: AnimationKeyframe[] = [];
        for (let j = 0; j < keyframeCount; j++) {
            const w0 = view.getUint16(trackTableIdx + 0x00);
            const unk = (w0 >>> 14);
            const time = (w0 >>> 0) & 0x3FFF;
            const value = view.getInt16(trackTableIdx + 0x02) / 0x40;
            keyframes.push({ unk, time, value });
            trackTableIdx += 0x04;
        }

        tracks.push({ boneID, trackType, frames: keyframes });
    }

    return { startFrame, endFrame, tracks };
}

class ObjectData {
    public geoData: (GeometryData | FlipbookData | null)[] = [];
    public gfxCache = new GfxRenderCache(true);

    constructor(private objectSetupData: ObjectSetupData) {
    }

    public ensureGeoData(device: GfxDevice, geoFileID: number): GeometryData | FlipbookData | null {
        if (this.geoData[geoFileID] === undefined) {
            if (geoFileID === 50 || geoFileID === 51 || geoFileID === 52) {
                // there are three models (objects 480, 411, 693) that look for a texture in a segment we don't have
                // one also seems to use the only IA16 texture in the game
                return null;
            }

            const file = findFileByID(this.objectSetupData, geoFileID);
            if (file === null) {
                console.log("missing file", geoFileID.toString(16))
                return null;
            }

            const geoData = file.Data;
            const view = geoData.createDataView();
            const magic = view.getUint32(0x00);

            // TODO: figure out what these other files are
            if (magic === 0x0000000B) {
                // TODO: find if models can set different Z/opacity modes
                const geo = Geo.parse(geoData, Geo.RenderZMode.OPA, true);
                this.geoData[geoFileID] = new GeometryData(device, this.gfxCache, geo);
            } else {
                return this.ensureFlipbookData(device, geoFileID);
            }
        }
        return this.geoData[geoFileID];
    }

    public ensureFlipbookData(device: GfxDevice, fileID: number): FlipbookData | null {
        if (this.geoData[fileID] === undefined) {
            const file = findFileByID(this.objectSetupData, fileID);
            if (file === null) {
                console.log("missing file", fileID.toString(16))
                return null;
            }

            const flipbook = Flipbook.parse(file.Data);
            this.geoData[fileID] = new FlipbookData(device, this.gfxCache, flipbook);
        }

        const data = this.geoData[fileID];
        if (data instanceof GeometryData) {
            throw `not a flipbook ${fileID}`
        } else {
            return data;
        }
    }

    public spawnFlipbookByFileID(device: GfxDevice, fileID: number, pos: vec3, phase = 0, initialMirror = false): FlipbookRenderer | null {
        const flipbookData = this.ensureFlipbookData(device, fileID);
        if (flipbookData === null) {
            console.warn(`Unsupported geo data for file ID ${hexzero(fileID, 4)}`);
            return null;
        }

        const renderer = new FlipbookRenderer(flipbookData, phase, initialMirror);
        renderer.sortKeyBase = makeSortKey(GfxRendererLayer.OPAQUE);
        mat4.fromTranslation(renderer.modelMatrix, pos);
        return renderer;
    }

    public spawnObjectByFileID(device: GfxDevice, fileID: number, pos: vec3, yaw = 0, pitch = 0): GeometryRenderer | FlipbookRenderer | null {
        const geoData = this.ensureGeoData(device, fileID);
        if (geoData === null) {
            console.warn(`Unsupported geo data for file ID ${hexzero(fileID, 4)}`);
            return null;
        }
        let modelMatrix: mat4;
        let renderer: GeometryRenderer | FlipbookRenderer;
        if (geoData instanceof GeometryData) {
            renderer = new GeometryRenderer(geoData);
        } else {
            renderer = new FlipbookRenderer(geoData)
        }
        renderer.sortKeyBase = makeSortKey(GfxRendererLayer.OPAQUE);
        mat4.fromTranslation(renderer.modelMatrix, pos);
        mat4.rotateY(renderer.modelMatrix, renderer.modelMatrix, yaw * MathConstants.DEG_TO_RAD);
        mat4.rotateZ(renderer.modelMatrix, renderer.modelMatrix, pitch * MathConstants.DEG_TO_RAD);
        return renderer;
    }

    public spawnObject(device: GfxDevice, id: number, pos: vec3, yaw = 0): GeometryRenderer | FlipbookRenderer | null {
        const spawnEntry = this.objectSetupData.ObjectSetupTable.find((entry) => entry.SpawnID === id);
        if (spawnEntry === undefined) {
            console.warn(`Unknown object ID ${hexzero(id, 4)}`);
            return null;
        }

        if (spawnEntry.GeoFileID === 0)
            return null; // nothing to render
        const renderer = this.spawnObjectByFileID(device, spawnEntry.GeoFileID, pos, yaw);
        if (renderer === null) {
            return null;
        }
        (renderer as any).spawnEntry = spawnEntry;

        if (renderer instanceof GeometryRenderer)
            renderer.objectFlags = spawnEntry.Flags;

        const animEntry = spawnEntry.AnimationTable[spawnEntry.AnimationStartIndex];
        if (animEntry !== undefined) {
            if (renderer instanceof GeometryRenderer) {
                const file = findFileByID(this.objectSetupData, animEntry.FileID);
                if (file !== null) {
                    const animFile = parseAnimationFile(file.Data);
                    renderer.boneAnimator = new BoneAnimator(animFile);
                }
            } else {
                console.warn(`animation data for flipbook object ${hexzero(id, 4)}`)
            }
        }
        return renderer;
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.geoData.length; i++) {
            const data = this.geoData[i];
            if (data !== undefined && data !== null)
                data.renderData.destroy(device);
        }

        this.gfxCache.destroy(device);
    }
}

async function fetchObjectData(dataFetcher: DataFetcher, device: GfxDevice): Promise<ObjectData> {
    const objectData = await dataFetcher.fetchData(`${pathBase}/objectSetup_arc.crg1?cache_bust=5`)!;
    const objectSetup = BYML.parse<ObjectSetupData>(objectData, BYML.FileType.CRG1);
    return new ObjectData(objectSetup);
}

class SceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string) {
    }

    private addGeo(device: GfxDevice, cache: GfxRenderCache, viewerTextures: Viewer.Texture[], sceneRenderer: BKRenderer, geo: Geo.Geometry): GeometryRenderer {
        for (let i = 0; i < geo.sharedOutput.textureCache.textures.length; i++)
            viewerTextures.push(textureToCanvas(geo.sharedOutput.textureCache.textures[i]));

        const geoData = new GeometryData(device, cache, geo);
        sceneRenderer.geoDatas.push(geoData.renderData);
        const geoRenderer = new GeometryRenderer(geoData);
        sceneRenderer.geoRenderers.push(geoRenderer);
        return geoRenderer;
    }

    private addObjects(device: GfxDevice, setupFile: ArrayBufferSlice, objectSetupTable: ObjectData, sceneRenderer: BKRenderer) {
        const view = setupFile.createDataView();
        assert(view.getInt16(0) === 0x0101);
        let offs = 2;

        const bounds: number[] = [];
        for (let i = 0; i < 6; i++) {
            bounds.push(view.getInt32(offs));
            offs += 4;
        }
        const totalEntries = (bounds[3] + 1 - bounds[0]) * (bounds[4] + 1 - bounds[1]) * (bounds[5] + 1 - bounds[2]);
        for (let i = 0; i < totalEntries; i++) {
            let dataType = view.getInt8(offs++);
            while (dataType !== 1) {
                if (dataType === 3) {
                    assert(view.getInt8(offs++) === 0x0A);
                    const groupSize = view.getUint8(offs++);
                    if (groupSize > 0)
                        assert(view.getInt8(offs++) === 0x0B);
                    for (let j = 0; j < groupSize; j++) {
                        const x = view.getInt16(offs + 0x00);
                        const y = view.getInt16(offs + 0x02);
                        const z = view.getInt16(offs + 0x04);
                        const selectorValue = (view.getUint16(offs + 0x06) >>> 7) & 0x1ff;
                        const category = (view.getUint8(offs + 0x07) >>> 1) & 0x3F;
                        const id = view.getUint16(offs + 0x08);
                        const yaw = view.getUint16(offs + 0x0C) >>> 7;

                        // skipping a couple of 0xc-bit fields
                        if (category === 0x06) {
                            const objRenderer = objectSetupTable.spawnObject(device, id, vec3.fromValues(x, y, z), yaw);
                            if (objRenderer instanceof GeometryRenderer) {
                                // special logic for doors and signs
                                if ((id === 0x203 || id === 0x2e3) && selectorValue > 0) {
                                    setSelectorValue(objRenderer.selectorState, selectorValue, 1)
                                }
                                sceneRenderer.geoRenderers.push(objRenderer);
                            } else if (objRenderer instanceof FlipbookRenderer) {
                                sceneRenderer.flipbookRenderers.push(objRenderer);
                            }
                        }
                        offs += 0x14;
                    }

                    assert(view.getInt8(offs++) === 0x8);
                    const structCount = view.getUint8(offs++);
                    if (structCount > 0) {
                        assert(view.getInt8(offs++) === 0x9);

                        for (let i = 0; i < structCount; i++) {
                            const fileIDBase = view.getUint16(offs + 0x00) >>> 4;
                            const x = view.getInt16(offs + 0x04);
                            const y = view.getInt16(offs + 0x06);
                            const z = view.getInt16(offs + 0x08);

                            const objectType = view.getUint8(offs + 0x0B) & 0x03;
                            if (objectType === 0) {
                                const params = view.getUint32(offs + 0x00);
                                const r = 1 - ((params >>> 16) & 0x07) * 0x10 / 0xff;
                                const g = 1 - ((params >>> 13) & 0x07) * 0x10 / 0xff;
                                const b = 1 - ((params >>> 10) & 0x07) * 0x10 / 0xff;
                                const scale = ((params >>> 2) & 0xff) / 100.0;
                                const initialMirror = (params >>> 1) & 0x01;
                                const startFrame = view.getUint8(offs + 0x0A) >>> 3; // gets overwritten by the computed frame
                                const phase = (view.getUint16(offs + 0x0A) >>> 6) & 0x1f;

                                const flipbook = objectSetupTable.spawnFlipbookByFileID(device, fileIDBase + 0x572, vec3.fromValues(x, y, z), phase, !!initialMirror);
                                if (flipbook) {
                                    flipbook.primColor = vec4.fromValues(r, g, b, 1);
                                    mat4.scale(flipbook.modelMatrix, flipbook.modelMatrix, [scale, scale, scale]);
                                    sceneRenderer.flipbookRenderers.push(flipbook);
                                }
                            } else if (objectType === 2) {
                                const yaw = view.getUint8(offs + 0x02) * 2;
                                const pitch = view.getUint8(offs + 0x03) * 2;
                                const scale = view.getUint8(offs + 0x0A) / 100.0;
                                const objRenderer = objectSetupTable.spawnObjectByFileID(device, fileIDBase + 0x2d1, vec3.fromValues(x, y, z), yaw, pitch);
                                if (objRenderer !== null) {
                                    mat4.scale(objRenderer.modelMatrix, objRenderer.modelMatrix, [scale, scale, scale]);
                                    if (objRenderer instanceof GeometryRenderer)
                                        sceneRenderer.geoRenderers.push(objRenderer);
                                    else
                                        throw `flipbook for normal setup object`;
                                }
                            }
                            offs += 0x0C;
                        }
                    }
                } else {
                    offs += 0x0C;
                }
                dataType = view.getInt8(offs++);
            }
        }
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const objectData = await context.dataShare.ensureObject<ObjectData>(`${pathBase}/ObjectData`, async () => {
            return await fetchObjectData(context.dataFetcher, device);
        });
        const dataFetcher = context.dataFetcher;
        return dataFetcher.fetchData(`${pathBase}/${this.id}_arc.crg1?cache_bust=2`).then((data) => {
            const obj: any = BYML.parse(data!, BYML.FileType.CRG1);

            const viewerTextures: Viewer.Texture[] = [];
            const fakeTextureHolder = new FakeTextureHolder(viewerTextures);
            const sceneRenderer = new BKRenderer(device, fakeTextureHolder);
            const cache = sceneRenderer.renderHelper.getCache();

            const opaFile = findFileByID(obj, obj.OpaGeoFileId);
            if (opaFile !== null) {
                const geo = Geo.parse(opaFile.Data, Geo.RenderZMode.OPA, true);
                const opa = this.addGeo(device, cache, viewerTextures, sceneRenderer, geo);
                opa.sortKeyBase = makeSortKey(GfxRendererLayer.OPAQUE);
                setLevelGeoSelector(opa, obj.SceneID);
            }

            const xluFile = findFileByID(obj, obj.XluGeoFileId);
            if (xluFile !== null) {
                const geo = Geo.parse(xluFile.Data, Geo.RenderZMode.XLU, false);
                const xlu = this.addGeo(device, cache, viewerTextures, sceneRenderer, geo);
                xlu.sortKeyBase = makeSortKey(GfxRendererLayer.TRANSLUCENT);
            }

            const opaSkybox = findFileByID(obj, obj.OpaSkyboxFileId);
            if (opaSkybox !== null) {
                const geo = Geo.parse(opaSkybox.Data, Geo.RenderZMode.OPA, true);
                const renderer = this.addGeo(device, cache, viewerTextures, sceneRenderer, geo);
                renderer.isSkybox = true;
                mat4.scale(renderer.modelMatrix, renderer.modelMatrix, [obj.OpaSkyboxScale, obj.OpaSkyboxScale, obj.OpaSkyboxScale]);
            }

            const xluSkybox = findFileByID(obj, obj.XluSkyboxFileId);
            if (xluSkybox !== null) {
                const geo = Geo.parse(xluSkybox.Data, Geo.RenderZMode.XLU, false);
                const renderer = this.addGeo(device, cache, viewerTextures, sceneRenderer, geo);
                renderer.isSkybox = true;
                mat4.scale(renderer.modelMatrix, renderer.modelMatrix, [obj.XluSkyboxScale, obj.XluSkyboxScale, obj.XluSkyboxScale]);
            }

            const setupFile = assertExists(findFileByID(obj, obj.SetupFileId));
            this.addObjects(device, setupFile.Data, objectData, sceneRenderer);

            return sceneRenderer;
        });
    }
}

// Names taken from Banjo's Backpack.
const id = `bk`;
const name = "Banjo-Kazooie";
const sceneDescs = [
    "Spiral Mountain",
    new SceneDesc(`01`, "Spiral Mountain"),
    new SceneDesc(`8C`, "Banjo's House"),

    "Grunty's Lair",
    new SceneDesc(`69`, "Floor 1 / Entrance to Mumbo's Mountain"),
    new SceneDesc(`6A`, "Floor 2"),
    new SceneDesc(`6C`, "Dingpot Teleport Room"),
    new SceneDesc(`6B`, "Floor 3"),
    new SceneDesc(`6D`, "Entrance to Treasure Trove Cove"),
    new SceneDesc(`70`, "Entrance to Clanker's Cavern"),
    new SceneDesc(`71`, "Floor 4"),
    new SceneDesc(`72`, "Entrance to Bubblegloomp Swamp"),
    new SceneDesc(`6E`, "Floor 5 / Entrance to Gobi's Valley"),
    new SceneDesc(`6F`, "Floor 6 / Entrance to Freezeezy Peak"),
    new SceneDesc(`75`, "Entrance to Mad Monster Mansion"),
    new SceneDesc(`74`, "Gobi's Valley Puzzle Room"),
    new SceneDesc(`79`, "Floor 7 / Entrance to Click Clock Wood"),
    new SceneDesc(`76`, "Water Switch Area"),
    new SceneDesc(`78`, "Mad Monster Mansion & Rusty Bucket Bay Puzzle Room"),
    new SceneDesc(`77`, "Entrance to Rusty Bucket Bay"),
    new SceneDesc(`93`, "Floor 8"),
    new SceneDesc(`7A`, "Coffin Room"),
    new SceneDesc(`80`, "Entrance to Grunty's Furnace Fun"),
    new SceneDesc(`8E`, "Grunty's Furnace Fun"),
    new SceneDesc(`90`, "Boss"),

    "Mumbo's Mountain",
    new SceneDesc(`02`, "Mumbo's Mountain"),
    new SceneDesc(`0C`, "Ticker's Tower"),
    new SceneDesc(`0E`, "Mumbo's Skull"),

    "Treasure Trove Cove",
    new SceneDesc(`07`, "Treasure Trove Cove"),
    new SceneDesc(`05`, "Blubber's Ship"),
    new SceneDesc(`06`, "Nipper's Shell"),
    new SceneDesc(`0A`, "Sandcastle"),
    new SceneDesc(`8F`, "Sharkfood Island"),

    "Clanker's Cavern",
    new SceneDesc(`0B`, "Clanker's Cavern"),
    new SceneDesc(`22`, "Inside Clanker"),
    new SceneDesc(`21`, "Inside Clanker - Witch Switch"),
    new SceneDesc(`23`, "Inside Clanker - Gold Feathers"),

    "Bubblegloop Swamp",
    new SceneDesc(`0D`, "Bubblegloop Swamp"),
    new SceneDesc(`10`, "Mr. Vile"),
    new SceneDesc(`11`, "TipTup Chior"),
    new SceneDesc(`47`, "Mumbo's Skull"),

    "Freezeezy Peak",
    new SceneDesc(`27`, "Freezeezy Peak"),
    new SceneDesc(`41`, "Boggy's Igloo"),
    new SceneDesc(`48`, "Mumbo's Skull"),
    new SceneDesc(`53`, "Christmas Tree"),
    new SceneDesc(`7F`, "Wozza's Cave"),

    "Gobi's Valley",
    new SceneDesc(`12`, "Gobi's Valley"),
    new SceneDesc(`13`, "Puzzle Room"),
    new SceneDesc(`14`, "King Sandybutt's Tomb"),
    new SceneDesc(`15`, "Water Room"),
    new SceneDesc(`16`, "Rupee"),
    new SceneDesc(`1A`, "Jinxy"),
    new SceneDesc(`92`, "Secret Blue Egg"),

    "Mad Monster Mansion",
    new SceneDesc(`1B`, "Mad Monster Mansion"),
    new SceneDesc(`8D`, "Septic Tank"),
    new SceneDesc(`1C`, "Church"),
    new SceneDesc(`1D`, "Cellar"),
    new SceneDesc(`24`, "Tumblar's Shed"),
    new SceneDesc(`25`, "Well"),
    new SceneDesc(`26`, "Dining Room"),
    new SceneDesc(`28`, "Egg Room"),
    new SceneDesc(`29`, "Note Room"),
    new SceneDesc(`2A`, "Feather Room"),
    new SceneDesc(`2B`, "Secret Church Room"),
    new SceneDesc(`2C`, "Bathroom"),
    new SceneDesc(`2D`, "Bedroom"),
    new SceneDesc(`2E`, "Gold Feather Room"),
    new SceneDesc(`2F`, "Drainpipe"),
    new SceneDesc(`30`, "Mumbo's Hut"),

    "Rusty Bucket Bay",
    new SceneDesc(`31`, "Rusty Bucket Bay"),
    new SceneDesc(`8B`, "Anchor Room"),
    new SceneDesc(`34`, "Machine Room"),
    new SceneDesc(`35`, "Big Fish Warehouse"),
    new SceneDesc(`36`, "Boat Room"),
    new SceneDesc(`37`, "First Blue Container"),
    new SceneDesc(`38`, "Third Blue Container"),
    new SceneDesc(`39`, "Sea-Grublin's Cabin"),
    new SceneDesc(`3A`, "Kaboom's Room"),
    new SceneDesc(`3B`, "Mini Kaboom's Room"),
    new SceneDesc(`3C`, "Kitchen"),
    new SceneDesc(`3D`, "Navigation Room"),
    new SceneDesc(`3E`, "Second Blue Container"),
    new SceneDesc(`3F`, "Captain's Room"),

    "Click Clock Wood",
    new SceneDesc(`40`, "Click Clock Wood"),
    new SceneDesc(`43`, "Spring"),
    new SceneDesc(`44`, "Summer"),
    new SceneDesc(`45`, "Fall"),
    new SceneDesc(`46`, "Winter"),
    new SceneDesc(`4A`, "Mumbo - Spring"),
    new SceneDesc(`4B`, "Mumbo - Summer"),
    new SceneDesc(`4C`, "Mumbo - Fall"),
    new SceneDesc(`4D`, "Mumbo - Winter"),
    new SceneDesc(`5A`, "Beehive - Summer"),
    new SceneDesc(`5B`, "Beehive - Spring"),
    new SceneDesc(`5C`, "Beehive - Fall"),
    new SceneDesc(`5E`, "Nabnuts House - Spring"),
    new SceneDesc(`5F`, "Nabnuts House - Summer"),
    new SceneDesc(`60`, "Nabnuts House - Fall"),
    new SceneDesc(`61`, "Nabnuts House - Winter"),
    new SceneDesc(`62`, "Nabnut's Attic - Winter"),
    new SceneDesc(`63`, "Nabnut's Attic - Fall"),
    new SceneDesc(`64`, "Nabnut's Attic 2 - Winter"),
    new SceneDesc(`65`, "Whipcrack Room - Spring"),
    new SceneDesc(`66`, "Whipcrack Room - Summer"),
    new SceneDesc(`67`, "Whipcrack Room - Fall"),
    new SceneDesc(`68`, "Whipcrack Room - Winter"),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
