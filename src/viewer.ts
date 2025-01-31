
import * as UI from './ui';

import InputManager from './InputManager';
import { SceneDesc, SceneGroup } from "./SceneBase";
import { CameraController, Camera } from './Camera';
import { TextureHolder } from './TextureHolder';
import { GfxDevice, GfxSwapChain, GfxRenderPass, GfxDebugGroup } from './gfx/platform/GfxPlatform';
import { createSwapChainForWebGL2, gfxDeviceGetImpl_GL, getPlatformTexture_GL } from './gfx/platform/GfxPlatformWebGL2';
import { createSwapChainForWebGPU } from './gfx/platform/GfxPlatformWebGPU';
import { downloadTextureToCanvas } from './Screenshot';
import { RenderStatistics, RenderStatisticsTracker } from './RenderStatistics';
import { NormalizedViewportCoords, ColorAttachment, makeClearRenderPassDescriptor } from './gfx/helpers/RenderTargetHelpers';
import { OpaqueBlack } from './Color';

export interface Texture {
    name: string;
    surfaces: HTMLCanvasElement[];
    extraInfo?: Map<string, string> | null;
    activate?: () => Promise<void>;
}

export interface ViewerRenderInput {
    camera: Camera;
    time: number;
    deltaTime: number;
    backbufferWidth: number;
    backbufferHeight: number;
    viewport: NormalizedViewportCoords;
}

export interface SceneGfx {
    textureHolder?: TextureHolder<any>;
    createPanels?(): UI.Panel[];
    createCameraController?(): CameraController;
    serializeSaveState?(dst: ArrayBuffer, offs: number): number;
    deserializeSaveState?(src: ArrayBuffer, offs: number, byteLength: number): number;
    onstatechanged?: () => void;
    render(device: GfxDevice, renderInput: ViewerRenderInput): GfxRenderPass;
    destroy(device: GfxDevice): void;
}

export type Listener = (viewer: Viewer) => void;

function resetGfxDebugGroup(group: GfxDebugGroup): void {
    group.bufferUploadCount = 0;
    group.drawCallCount = 0;
    group.textureBindCount = 0;
    group.triangleCount = 0;
}

export function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number, devicePixelRatio: number): void {
    canvas.setAttribute('style', `width: ${width}px; height: ${height}px;`);
    canvas.width = width * devicePixelRatio;
    canvas.height = height * devicePixelRatio;
}

// TODO(jstpierre): Find a more elegant way to write this that doesn't take as many resources.
class ClearScene {
    public colorAttachment = new ColorAttachment();
    private renderPassDescriptor = makeClearRenderPassDescriptor(true, OpaqueBlack);

    public minimize(device: GfxDevice): void {
        this.colorAttachment.setParameters(device, 1, 1, 1);
    }

    public render(device: GfxDevice, viewerRenderInput: ViewerRenderInput): GfxRenderPass {
        this.colorAttachment.setParameters(device, viewerRenderInput.backbufferWidth, viewerRenderInput.backbufferHeight);
        this.renderPassDescriptor.colorAttachment = this.colorAttachment.gfxColorAttachment;
        return device.createRenderPass(this.renderPassDescriptor);
    }

    public destroy(device: GfxDevice): void {
        this.colorAttachment.destroy(device);
    }
}

export class Viewer {
    public inputManager: InputManager;
    public cameraController: CameraController | null = null;

    public camera = new Camera();
    public fovY: number = Math.PI / 4;
    // Scene time. Can be paused / scaled / rewound / whatever.
    public sceneTime: number = 0;
    // requestAnimationFrame time. Used to calculate dt from the new time.
    public rafTime: number = 0;
    public sceneTimeScale: number = 1;

    public gfxDevice: GfxDevice;
    public viewerRenderInput: ViewerRenderInput;
    public renderStatisticsTracker = new RenderStatisticsTracker();
    public viewport: NormalizedViewportCoords = { x: 0, y: 0, w: 1, h: 1 };

    public scene: SceneGfx | null = null;

    public oncamerachanged: () => void = (() => {});
    public onstatistics: (statistics: RenderStatistics) => void = (() => {});

    private keyMoveSpeedListeners: Listener[] = [];
    private debugGroup: GfxDebugGroup = { name: 'Scene Rendering', drawCallCount: 0, bufferUploadCount: 0, textureBindCount: 0, triangleCount: 0 };
    private clearScene: ClearScene = new ClearScene();

    constructor(private gfxSwapChain: GfxSwapChain, public canvas: HTMLCanvasElement) {
        this.inputManager = new InputManager(this.canvas);
        this.rafTime = window.performance.now();

        // GfxDevice.
        this.gfxDevice = this.gfxSwapChain.getDevice();
        this.viewerRenderInput = {
            camera: this.camera,
            time: this.sceneTime,
            deltaTime: 0,
            backbufferWidth: 0,
            backbufferHeight: 0,
            viewport: this.viewport,
        };
    }

    private onKeyMoveSpeed(): void {
        for (let i = 0; i < this.keyMoveSpeedListeners.length; i++)
            this.keyMoveSpeedListeners[i](this);
    }

    public setKeyMoveSpeed(n: number): void {
        if (this.cameraController === null)
            return;
        this.cameraController.setKeyMoveSpeed(n);
        this.onKeyMoveSpeed();
    }

    public addKeyMoveSpeedListener(listener: Listener): void {
        this.keyMoveSpeedListeners.push(listener);
    }

    private render(): void {
        this.viewerRenderInput.time = this.sceneTime;
        this.viewerRenderInput.backbufferWidth = this.canvas.width;
        this.viewerRenderInput.backbufferHeight = this.canvas.height;
        this.gfxSwapChain.configureSwapChain(this.canvas.width, this.canvas.height);

        this.renderStatisticsTracker.beginFrame();

        resetGfxDebugGroup(this.debugGroup);
        this.gfxDevice.pushDebugGroup(this.debugGroup);

        let renderPass: GfxRenderPass | null = null;
        if (this.scene !== null)
            renderPass = this.scene.render(this.gfxDevice, this.viewerRenderInput);

        if (renderPass === null) {
            renderPass = this.clearScene.render(this.gfxDevice, this.viewerRenderInput);
        } else {
            this.clearScene.minimize(this.gfxDevice);
        }

        const onscreenTexture = this.gfxSwapChain.getOnscreenTexture();
        renderPass.endPass(onscreenTexture);
        this.gfxDevice.submitPass(renderPass);

        this.gfxSwapChain.present();

        this.gfxDevice.popDebugGroup();
        this.renderStatisticsTracker.endFrame();

        this.renderStatisticsTracker.applyDebugGroup(this.debugGroup);
        this.onstatistics(this.renderStatisticsTracker);
    }

    public setCameraController(cameraController: CameraController) {
        this.cameraController = cameraController;
        this.cameraController.camera = this.camera;
        this.cameraController.forceUpdate = true;
    }

    public setScene(scene: SceneGfx | null): void {
        this.scene = scene;
        this.cameraController = null;
    }

    public setSceneTime(newTime: number): void {
        this.viewerRenderInput.deltaTime += newTime - this.sceneTime;
        this.sceneTime = newTime;
    }

    public update(nt: number): void {
        const dt = nt - this.rafTime;
        if (dt < 0)
            return;
        this.rafTime = nt;

        const camera = this.camera;

        // Hack in projection for now until we have that unfolded from RenderState.
        camera.newFrame();
        const aspect = this.canvas.width / this.canvas.height;
        camera.fovY = this.fovY;
        camera.aspect = aspect;
        camera.setClipPlanes(5);

        if (this.cameraController) {
            const updated = this.cameraController.update(this.inputManager, dt);
            if (updated)
                this.oncamerachanged();
        }

        // TODO(jstpierre): Move this to main
        this.inputManager.afterFrame();

        const deltaTime = dt * this.sceneTimeScale;
        this.viewerRenderInput.deltaTime += deltaTime;
        this.sceneTime += deltaTime;

        this.render();

        // Reset the delta for next frame.
        this.viewerRenderInput.deltaTime = 0;
    }

    public takeScreenshotToCanvas(opaque: boolean): HTMLCanvasElement {
        const canvas = document.createElement('canvas');

        // TODO(jstpierre)
        // Reading the resolved color texture gives us fringes, because the standard box filter will
        // add the clear color just like the standard texture sample fringes... in order to get a
        // nice-looking screenshot, we'd need to do a custom resolve of the MSAA render target.

        if (this.scene !== null) {
            // TODO(jstpierre): Implement in Gfx somehow.
            const gl = gfxDeviceGetImpl_GL(this.gfxDevice).gl;
            const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
            downloadTextureToCanvas(gl, getPlatformTexture_GL(this.gfxSwapChain.getOnscreenTexture()), width, height, canvas, opaque);
        }

        return canvas;
    }
}

export { SceneDesc, SceneGroup };

interface ViewerOut {
    viewer: Viewer;
}

export const enum InitErrorCode {
    SUCCESS,
    NO_WEBGL2_GENERIC,
    NO_WEBGL2_SAFARI,
    GARBAGE_WEBGL2_GENERIC,
    GARBAGE_WEBGL2_SWIFTSHADER,
    MISSING_MISC_WEB_APIS,
}

async function initializeViewerWebGL2(out: ViewerOut, canvas: HTMLCanvasElement): Promise<InitErrorCode> {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: false });
    // For debugging purposes, add a hook for this.
    (window as any).gl = gl;
    if (!gl) {
        if (navigator.vendor.includes('Apple'))
            return InitErrorCode.NO_WEBGL2_SAFARI;
        else
            return InitErrorCode.NO_WEBGL2_GENERIC;
    }

    // Test for no MS depthbuffer support (as seen in SwiftShader).
    const samplesArray = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH32F_STENCIL8, gl.SAMPLES);
    if (samplesArray === null || samplesArray.length === 0) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        console.warn(`samplesArray = ${samplesArray}`);
        if (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL).includes('SwiftShader'))
            return InitErrorCode.GARBAGE_WEBGL2_SWIFTSHADER;
        else
            return InitErrorCode.GARBAGE_WEBGL2_GENERIC;
    }

    const gfxSwapChain = createSwapChainForWebGL2(gl);
    out.viewer = new Viewer(gfxSwapChain, canvas);

    return InitErrorCode.SUCCESS;
}

async function initializeViewerWebGPU(out: ViewerOut, canvas: HTMLCanvasElement): Promise<InitErrorCode> {
    const gfxSwapChain = await createSwapChainForWebGPU(canvas);
    if (gfxSwapChain === null)
        return InitErrorCode.MISSING_MISC_WEB_APIS;

    out.viewer = new Viewer(gfxSwapChain, canvas);
    return InitErrorCode.SUCCESS;
}

export async function initializeViewer(out: ViewerOut, canvas: HTMLCanvasElement): Promise<InitErrorCode> {
    const useWebGPU = window.localStorage.getItem('webgpu');
    if (useWebGPU)
        return initializeViewerWebGPU(out, canvas);
    else
        return initializeViewerWebGL2(out, canvas);
}

export function makeErrorMessageUI(message: string): DocumentFragment {
    const errorMessage = UI.createDOMFromString(`
<div style="display: flex; background-color: #220000; flex-direction: column; position: absolute; top: 0; bottom: 0; left: 0; right: 0; justify-content: center;">
<div style="display: flex; background-color: #aa2233; justify-content: center; box-shadow: 0 0 32px black;">
<div style="max-width: 1000px; font: 16pt sans-serif; color: white; text-align: justify;">
<style>
a:link, a:visited { color: #ccc; transition: .5s color; }
a:hover { color: #fff; }
</style>
${message}
`);

    return errorMessage;
}

export function makeErrorUI(errorCode: InitErrorCode): DocumentFragment {
    if (errorCode === InitErrorCode.NO_WEBGL2_SAFARI)
        return makeErrorMessageUI(`
<p>This application requires WebGL 2. Unfortunately, that means Safari and iOS are currently not supported. The plan is to support <a href="https://github.com/gpuweb/gpuweb">WebGPU</a> once this arrives.
`);
    else if (errorCode === InitErrorCode.NO_WEBGL2_GENERIC)
        return makeErrorMessageUI(`
<p>Your browser does not appear to have WebGL 2 support.
<p>If <a href="http://webglreport.com/?v=2">WebGL Report</a> says your browser supports WebGL 2, please open a <a href="https://github.com/magcius/noclip.website/issues/new?template=tech_support.md">GitHub issue</a> with as much as information as possible.
<p style="text-align: right">Thanks, Jasper.
`);
    else if (errorCode === InitErrorCode.GARBAGE_WEBGL2_SWIFTSHADER)
        return makeErrorMessageUI(`
<p>This application requires hardware acceleration to be enabled.
<p>Please enable hardware acceleration in your's browser settings.
<p>If you have enabled hardware acceleration and are still getting this error message, please open a <a href="https://github.com/magcius/noclip.website/issues/new?template=tech_support.md">GitHub issue</a> with as much as information as possible.
<p style="text-align: right">Thanks, Jasper.
`);
    else if (errorCode === InitErrorCode.GARBAGE_WEBGL2_GENERIC)
        return makeErrorMessageUI(`
<p>This browser has a non-functioning version of WebGL 2 that I have not seen before.
<p>If <a href="http://webglreport.com/?v=2">WebGL Report</a> says your browser supports WebGL 2, please open a <a href="https://github.com/magcius/noclip.website/issues/new?template=tech_support.md">GitHub issue</a> with as much as information as possible.
<p style="text-align: right">Thanks, Jasper.
`);
    else if (errorCode === InitErrorCode.MISSING_MISC_WEB_APIS)
        return makeErrorMessageUI(`
<p>Your browser is too old and is missing support for web APIs that I rely on.
<p>Please try to update your browser to a more recent version.
`);
    else
        throw "whoops";
}
