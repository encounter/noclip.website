use core::f32;

use nalgebra_glm::{make_mat4, make_vec3, triangle_normal, vec3, vec4, Mat4, Vec3};
use wasm_bindgen::prelude::*;

#[derive(Default, Debug, Clone)]
pub struct Plane {
    pub d: f32,
    pub normal: Vec3,
}

impl Plane {
    pub fn negate(&mut self) {
        self.normal.neg_mut();
        self.d *= -1.0;
    }

    pub fn set_tri(&mut self, p0: &Vec3, p1: &Vec3, p2: &Vec3) {
        self.normal = triangle_normal(p0, p1, p2);
        self.d = -self.normal.dot(&p0);
    }

    pub fn distance(&self, p: &Vec3) -> f32 {
        self.normal.dot(p) + self.d
    }

    pub fn intersect_line(&self, p: &Vec3, dir: &Vec3) -> Vec3 {
        let t = -(self.normal.dot(p) + self.d) / self.normal.dot(dir);
        p + t * dir
    }

    pub fn transform(&mut self, inv_transpose_mat: &Mat4) {
        let transformed =
            inv_transpose_mat * vec4(self.normal.x, self.normal.y, self.normal.z, self.d);
        self.normal.x = transformed.x;
        self.normal.y = transformed.y;
        self.normal.z = transformed.z;
        self.d = transformed.w;
    }
}

#[derive(Debug, Clone)]
pub struct AABB {
    pub min: Vec3,
    pub max: Vec3,
}

impl Default for AABB {
    fn default() -> Self {
        Self {
            min: Vec3::from_element(f32::INFINITY),
            max: Vec3::from_element(f32::NEG_INFINITY),
        }
    }
}

impl AABB {
    pub fn from_f32(min_x: f32, min_y: f32, min_z: f32, max_x: f32, max_y: f32, max_z: f32) -> Self {
        AABB {
            min: Vec3::new(min_x, min_y, min_z),
            max: Vec3::new(max_x, max_y, max_z),
        }
    }

    pub fn from_slice(slice: &[f32]) -> Self {
        assert_eq!(slice.iter().count(), 6);
        AABB {
            min: make_vec3(&slice[0..3]),
            max: make_vec3(&slice[3..6]),
        }
    }

    pub fn transform(&mut self, mat: &Mat4) {
        // Transforming Axis-Aligned Bounding Boxes from Graphics Gems.
        let min = self.min.clone();
        let max = self.max.clone();

        // Translation can be applied directly
        self.min.x = mat[12];
        self.min.y = mat[13];
        self.min.z = mat[14];
        self.max.copy_from(&self.min);

        for i in 0..3 {
            for j in 0..3 {
                let a = mat[i * 4 + j] * min[i];
                let b = mat[i * 4 + j] * max[i];
                self.min[j] += a.min(b);
                self.max[j] += a.max(b);
            }
        }
    }

    pub fn set_from_points(&mut self, points: &[Vec3]) {
        self.min = Vec3::from_element(f32::INFINITY);
        self.max = Vec3::from_element(f32::NEG_INFINITY);

        for p in points {
            self.min.x = self.min.x.min(p.x);
            self.min.y = self.min.y.min(p.y);
            self.min.z = self.min.z.min(p.z);
            self.max.x = self.max.x.max(p.x);
            self.max.y = self.max.y.max(p.y);
            self.max.z = self.max.z.max(p.z);
        }
    }

    pub fn contains_point(&self, p: &Vec3) -> bool {
        !(p.x < self.min.x
            || p.x > self.max.x
            || p.y < self.min.y
            || p.y > self.max.y
            || p.z < self.min.z
            || p.z > self.max.z)
    }
}

#[wasm_bindgen(js_name = "IntersectionState")]
pub enum IntersectionState {
    Inside,
    Outside,
    Intersection,
}

// can be used as a Frustum
#[wasm_bindgen(js_name = "ConvexHull")]
#[derive(Debug, Clone)]
pub struct ConvexHull {
    pub(crate) planes: Vec<Plane>,
}

impl ConvexHull {
    pub fn contains_point(&self, p: &Vec3) -> bool {
        for plane in &self.planes {
            if plane.distance(p) > 0.0 {
                return false;
            }
        }
        return true;
    }

    pub fn intersect_aabb(&self, aabb: &AABB) -> IntersectionState {
        let mut result = IntersectionState::Inside;
        for plane in &self.planes {
            let nearest = vec3(
                if plane.normal.x >= 0.0 {
                    aabb.min.x
                } else {
                    aabb.max.x
                },
                if plane.normal.y >= 0.0 {
                    aabb.min.y
                } else {
                    aabb.max.y
                },
                if plane.normal.z >= 0.0 {
                    aabb.min.z
                } else {
                    aabb.max.z
                },
            );
            if plane.distance(&nearest) > 0.0 {
                return IntersectionState::Outside;
            }
            let farthest = vec3(
                if plane.normal.x >= 0.0 {
                    aabb.max.x
                } else {
                    aabb.min.x
                },
                if plane.normal.y >= 0.0 {
                    aabb.max.y
                } else {
                    aabb.min.y
                },
                if plane.normal.z >= 0.0 {
                    aabb.max.z
                } else {
                    aabb.min.z
                },
            );
            if plane.distance(&farthest) > 0.0 {
                result = IntersectionState::Intersection;
            }
        }
        result
    }

    pub fn intersect_sphere(&self, center: &Vec3, radius: f32) -> IntersectionState {
        let mut result = IntersectionState::Inside;
        for plane in &self.planes {
            let dist = plane.distance(center);
            if dist > radius {
                return IntersectionState::Outside;
            } else if dist > -radius {
                result = IntersectionState::Intersection;
            }
        }
        return result;
    }

    pub fn contains_aabb(&self, aabb: &AABB) -> bool {
        match self.intersect_aabb(aabb) {
            IntersectionState::Outside => false,
            _ => true,
        }
    }

    pub fn contains_sphere(&self, center: &Vec3, radius: f32) -> bool {
        match self.intersect_sphere(center, radius) {
            IntersectionState::Outside => false,
            _ => true,
        }
    }

    pub fn transform(&mut self, mat: &Mat4) {
        let mut inv_transpose_mat = mat.try_inverse().unwrap();
        inv_transpose_mat.transpose_mut();
        for plane in &mut self.planes {
            plane.transform(&inv_transpose_mat);
        }
    }
}

#[wasm_bindgen(js_class = "ConvexHull")]
impl ConvexHull {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        ConvexHull { planes: Vec::new() }
    }

    pub fn copy(&mut self) -> Self {
        return self.clone()
    }

    pub fn clear(&mut self) {
        self.planes.clear();
    }

    pub fn push_plane(&mut self, x: f32, y: f32, z: f32, d: f32) {
        let normal = Vec3::new(x, y, z);
        self.planes.push(Plane { normal, d });
    }

    pub fn js_intersect_aabb(&mut self, min_x: f32, min_y: f32, min_z: f32, max_x: f32, max_y: f32, max_z: f32) -> IntersectionState {
        let aabb = AABB::from_f32(min_x, min_y, min_z, max_x, max_y, max_z);
        self.intersect_aabb(&aabb)
    }

    pub fn js_contains_aabb(&mut self, min_x: f32, min_y: f32, min_z: f32, max_x: f32, max_y: f32, max_z: f32) -> bool {
        let aabb = AABB::from_f32(min_x, min_y, min_z, max_x, max_y, max_z);
        self.contains_aabb(&aabb)
    }

    pub fn js_contains_point(&mut self, pt_slice: &[f32]) -> bool {
        assert_eq!(pt_slice.iter().count(), 3);
        let pt = make_vec3(pt_slice);
        self.contains_point(&pt)
    }

    pub fn js_intersect_sphere(&mut self, x: f32, y: f32, z: f32, radius: f32) -> IntersectionState {
        let center = Vec3::new(x, y, z);
        self.intersect_sphere(&center, radius)
    }

    pub fn js_contains_sphere(&mut self, x: f32, y: f32, z: f32, radius: f32) -> bool {
        let center = Vec3::new(x, y, z);
        self.contains_sphere(&center, radius)
    }

    pub fn js_transform(&mut self, mat_slice: &[f32]) {
        assert_eq!(mat_slice.iter().count(), 16);
        let mat = make_mat4(mat_slice);
        self.transform(&mat);
    }

    pub fn debug_str(&self) -> String {
        format!("{:?}", self)
    }
}
