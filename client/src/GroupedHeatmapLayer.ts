/**
 * GroupedHeatmapLayer — a BitmapLayer extension that performs colour mapping
 * on the GPU.
 *
 * Per the architecture spec (Rule #2), the backend serves 8-bit grayscale
 * tiles (raw expression values 0..255). This layer's custom fragment shader:
 *   1. Reads the raw grayscale expression value from the tile texture.
 *   2. Discards padding/null pixels (value <= 0.001).
 *   3. Maps the normalised value through a 256x1 colour LUT texture
 *      (Viridis / Magma / Plasma / Inferno) to produce the heatmap colour.
 *
 * The colour LUT texture is injected as a binding (`colorMapLUT`) alongside
 * the bitmap texture, so switching palettes is instant (no re-fetch).
 *
 * Part of the High-Performance Single-Cell Heatmap Architecture (Step 4).
 */
import { BitmapLayer } from "@deck.gl/layers";
import { Texture } from "@luma.gl/core";

/** Props for the grouped heatmap layer (extends BitmapLayer). */
export interface GroupedHeatmapLayerProps {
  /** Grayscale tile image (HTMLImageElement / Texture). */
  image: any;
  /** 4-corner world-space bounds [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]. */
  bounds: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  /** 256x1 RGBA colour LUT texture (built from colormap.ts getLutData). */
  colorMapLUT?: Texture;
  /** Texture filtering parameters. */
  textureParameters?: Record<string, any>;
  /** Optional layer id. */
  id?: string;
}

/**
 * Custom fragment shader. We keep the bitmap UBO (bounds, coordinateConversion,
 * etc.) and the `bitmapTexture` sampler from the base layer, and add a
 * `colorMapLUT` sampler for the palette lookup.
 */
const customFragmentShader = `\
#version 300 es
#define SHADER_NAME heatmap-fragment-shader

#ifdef GL_ES
precision highp float;
#endif

uniform sampler2D bitmapTexture;
uniform sampler2D colorMapLUT;

in vec2 vTexCoord;
in vec2 vTexPos;

out vec4 fragColor;

/* projection utils (kept from base bitmap shader for coordinateConversion) */
const float TILE_SIZE = 512.0;
const float PI = 3.1415926536;
const float WORLD_SCALE = TILE_SIZE / PI / 2.0;

vec2 lnglat_to_mercator(vec2 lnglat) {
  float x = lnglat.x;
  float y = clamp(lnglat.y, -89.9, 89.9);
  return vec2(
    radians(x) + PI,
    PI + log(tan(PI * 0.25 + radians(y) * 0.5))
  ) * WORLD_SCALE;
}

vec2 mercator_to_lnglat(vec2 xy) {
  xy /= WORLD_SCALE;
  return degrees(vec2(
    xy.x - PI,
    atan(exp(xy.y - PI)) * 2.0 - PI * 0.5
  ));
}

vec2 getUV(vec2 pos) {
  return vec2(
    (pos.x - bitmap.bounds[0]) / (bitmap.bounds[2] - bitmap.bounds[0]),
    (pos.y - bitmap.bounds[3]) / (bitmap.bounds[1] - bitmap.bounds[3])
  );
}

void main(void) {
  vec2 uv = vTexCoord;
  if (bitmap.coordinateConversion < -0.5) {
    vec2 lnglat = mercator_to_lnglat(vTexPos);
    uv = getUV(lnglat);
  } else if (bitmap.coordinateConversion > 0.5) {
    vec2 commonPos = lnglat_to_mercator(vTexPos);
    uv = getUV(commonPos);
  }

  // 1. Fetch the raw grayscale byte value (0..255) from the tile texture.
  //    The texture sampler returns it normalised to 0.0..1.0, so multiply
  //    back to the 0..255 byte range.
  float grayByte = texture(bitmapTexture, uv).r * 255.0;

  // 2. Discard padding/null pixels (byte 0 = null value).
  if (grayByte <= 0.5) {
    discard;
  }

  // 3. Remap the byte range 1..255 (vmin..vmax) to the LUT range 0..1 so the
  //    full colour palette is used. Byte 1 (lowest real expression) maps
  //    to LUT index 0 (palette start), byte 255 (highest) to index 1 (end).
  float lutT = clamp((grayByte - 1.0) / 254.0, 0.0, 1.0);

  // 4. Map expression value to heatmap colour via the LUT texture.
  vec4 color = texture(colorMapLUT, vec2(lutT, 0.5));
  fragColor = vec4(color.rgb, color.a * layer.opacity);

  geometry.uv = uv;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

/**
 * GroupedHeatmapLayer extends deck.gl's BitmapLayer with a custom fragment
 * shader that maps grayscale tile values through a colour LUT on the GPU.
 */
export class GroupedHeatmapLayer extends BitmapLayer {
  static layerName = "GroupedHeatmapLayer";
  static defaultProps = {
    ...BitmapLayer.defaultProps,
    colorMapLUT: { type: "object", value: null, async: true },
  };

  getShaders() {
    const shaders = super.getShaders();
    // Replace the fragment shader with our colour-mapping version.
    shaders.fs = customFragmentShader;
    return shaders;
  }

  draw(opts: any) {
    const { shaderModuleProps } = opts;
    const { model, coordinateConversion, bounds, disablePicking } = this.state;
    // `colorMapLUT` is a custom prop we added via defaultProps; cast to access it.
    const props = this.props as any;
    const { image, desaturate, transparentColor, tintColor, colorMapLUT } =
      props;
    if (shaderModuleProps.picking.isActive && disablePicking) {
      return;
    }
    if (image && model) {
      const bitmapProps = {
        bitmapTexture: image,
        bounds,
        coordinateConversion,
        desaturate,
        tintColor: tintColor.slice(0, 3).map((x: number) => x / 255),
        transparentColor: transparentColor.map((x: number) => x / 255),
        // The colour LUT texture is routed as a binding (sampler),
        // exactly like bitmapTexture, via splitUniformsAndBindings.
        colorMapLUT,
      };
      model.shaderInputs.setProps({ bitmap: bitmapProps });
      model.draw(this.context.renderPass);
    }
  }
}

export default GroupedHeatmapLayer;
