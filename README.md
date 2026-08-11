# GNOME Honeycomb

GNOME Honeycomb replaces GNOME's paginated Applications grid with a centered, rotatable application universe. Application icons are distributed deterministically over a virtual sphere, projected into the GNOME Overview, depth-scaled, faded toward the rear hemisphere, and locally magnified by a magnetic pointer field.

The result is a launcher that behaves less like pages and more like a rotatable bubble of applications: the center stays fixed while dragging rotates the application universe around it.

## Features

- One continuous application universe with GNOME app folders flattened into individual applications.
- Fixed-center spherical navigation: drag to rotate instead of translating the whole grid.
- Deterministic Fibonacci-sphere distribution for arbitrary application counts.
- Magnetic magnification and local bubble/repulsion around the pointer.
- Depth-aware scale, opacity, reactivity, and stacking.
- Direct application activation by clicking an icon.
- GNOME's stock pagination controls are hidden while Honeycomb is active and restored afterward.
- Full lifecycle cleanup when Overview closes or the extension is disabled.

## Requirements

- GNOME Shell 50
- A GNOME Shell 50 session

## Interaction

- Move the pointer across the sphere to magnify nearby applications.
- Hold the primary mouse button and drag horizontally or vertically to rotate the sphere.
- Click without crossing the drag threshold to launch an application.

## Mathematics and geometry

Honeycomb's motion is deterministic. No random coordinates are used. Each application receives a point on a unit sphere, the sphere is rotated from pointer drag input, and the resulting 3D point is projected into the 2D Applications viewport.

### 1. Fibonacci-sphere distribution

For `N > 1` applications and index `i = 0, ..., N - 1`, Honeycomb uses the golden angle

```text
alpha = pi * (3 - sqrt(5))
```

which is approximately `2.3999632297` radians.

The vertical coordinate is distributed uniformly from the north to the south pole:

```text
y_i = 1 - 2i / (N - 1)
```

The radius of the horizontal slice of the unit sphere is

```text
r_i = sqrt(max(0, 1 - y_i^2))
```

and the azimuth is

```text
theta_i = alpha * i
```

so the original unit-sphere coordinates are

```text
x_i = cos(theta_i) * r_i
z_i = sin(theta_i) * r_i
```

with polar angle

```text
phi_i = acos(clamp(y_i, -1, 1))
```

Thus every application starts from a deterministic vector

```text
p_i = (x_i, y_i, z_i)
```

on the unit sphere. The special case `N = 1` uses `(0, 0, 1)`.

### 2. Pointer drag to angular rotation

Honeycomb does not translate the application cluster. Drag displacement changes two angular state variables: yaw and pitch.

For horizontal and vertical drag deltas `dx` and `dy`, with sensitivity `s = 0.005` radians per pixel:

```text
yaw   = normalize(yaw_start + dx * s)
pitch = clamp(pitch_start - dy * s, -1.25, +1.25)
```

Yaw is normalized to the interval `[-pi, pi]`. Pitch is bounded to avoid pole-flip behavior.

A drag becomes a rotation gesture only after the Euclidean displacement reaches the 6-pixel threshold:

```text
sqrt(dx^2 + dy^2) >= 6
```

Shorter gestures remain clicks.

### 3. Yaw rotation

Let `(x, y, z)` be an application's original sphere vector. Rotation around the Y axis by yaw `psi` gives

```text
x1 =  x cos(psi) + z sin(psi)
y1 =  y
z1 = -x sin(psi) + z cos(psi)
```

### 4. Pitch rotation

The yaw-rotated vector is then rotated around the X axis by pitch `beta`:

```text
rx = x1
ry = y1 cos(beta) - z1 sin(beta)
rz = y1 sin(beta) + z1 cos(beta)
```

`rz` is the depth coordinate used for visibility, scale, and stacking.

### 5. Fixed-center 3D-to-2D projection

For viewport width `W` and height `H`, the visual center is always

```text
Cx = W / 2
Cy = H / 2
```

Dragging never changes `(Cx, Cy)`.

Honeycomb deliberately uses an elliptical projection rather than a perfectly circular sphere:

```text
Rx = min(0.31 * W, 600)
Ry = min(0.39 * H, 300)
```

The projected icon center is

```text
screenX = Cx + rx * Rx
screenY = Cy + ry * Ry
```

Using different horizontal and vertical radii preserves the broad honeycomb/bubble silhouette while retaining spherical navigation.

### 6. Depth normalization and scale

Depth is normalized from `[-1, 1]` into `[0, 1]`:

```text
d = clamp((rz + 1) / 2, 0, 1)
```

The base icon scale is linearly interpolated between the rear and front scale constants:

```text
S_back  = 0.45
S_front = 1.05

baseScale = S_back + (S_front - S_back) * d
```

Icons facing the viewer therefore appear larger than icons curving away from the viewer.

### 7. Rear-hemisphere fade

The current rear cutoff is

```text
c = -0.15
```

Visibility is computed as

```text
visibility = clamp((rz - c) / 0.25, 0, 1)
```

and converted to Clutter opacity with

```text
opacity = round(255 * visibility)
```

This produces a soft transition instead of abruptly removing icons as they rotate behind the visible surface. Actors with very low opacity are also made non-reactive so invisible applications do not intercept pointer input.

### 8. Magnetic pointer field

For a projected icon center `(X_i, Y_i)` and pointer position `(P_x, P_y)`, define

```text
dx = X_i - P_x
dy = Y_i - P_y
distance = sqrt(dx^2 + dy^2)
```

with magnetic radius

```text
R_m = 180
```

The normalized distance is

```text
q = distance / R_m
```

and the magnetic influence is a Gaussian radial field

```text
w = exp(-(q^2))
```

Therefore `w = 1` directly under the pointer and smoothly approaches zero with distance.

### 9. Magnetic magnification

The spherical depth scale is multiplied, not replaced, by the magnetic field:

```text
M = 1 + 0.40 * w
finalScale = baseScale * M
```

This is why an icon can simultaneously express its depth on the virtual sphere and grow locally under the pointer.

### 10. Bubble / repulsion displacement

For `distance > 1`, neighboring icons are pushed radially away from the pointer by

```text
repulsion = 34 * w

targetX = X_i + (dx / distance) * repulsion
targetY = Y_i + (dy / distance) * repulsion
```

The displacement changes only the projected target position. It never changes the application's permanent coordinates on the Fibonacci sphere.

### 11. Smooth interpolation

Position, scale, and opacity do not jump immediately to their target values. Each interaction frame uses linear interpolation with

```text
lambda = 0.18
```

For a generic current value `v` and target value `t`:

```text
v_next = v + (t - v) * lambda
```

The same recurrence is applied independently to X, Y, scale, and opacity until the remaining difference is below a small threshold. This creates the soft magnetic/bubble motion without a physics engine.

### 12. Depth ordering

After projection, application actors are ordered by `rz` from back to front. When depths are effectively equal, current scale is used as a secondary ordering criterion. This keeps front-facing and magnified icons visually above deeper icons.

### Mathematical pipeline

The complete visual pipeline can be summarized as

```text
application index
      |
      v
Fibonacci sphere
(x, y, z)
      |
      v
yaw + pitch rotation
(rx, ry, rz)
      |
      +-----------------------> depth -> scale / opacity / stacking
      |
      v
fixed-center elliptical projection
(screenX, screenY)
      |
      v
Gaussian pointer field
      |
      +--> magnetic scale
      +--> radial repulsion
      |
      v
linear interpolation
      |
      v
Clutter actor position / scale / opacity
```

This separation is intentional: spherical coordinates define *where an application belongs*, rotation defines *which part of the universe faces the user*, projection defines *where it appears on screen*, and the magnetic field provides only a temporary local deformation.

## Install from source

Clone the repository and install it under the extension UUID directory:

```bash
git clone https://github.com/adlair/gnome-honeycomb.git
cd gnome-honeycomb
mkdir -p ~/.local/share/gnome-shell/extensions/gnome-honeycomb@adlair
cp extension.js metadata.json stylesheet.css LICENSE \
  ~/.local/share/gnome-shell/extensions/gnome-honeycomb@adlair/
gnome-extensions enable gnome-honeycomb@adlair
```

On Wayland, if GNOME Shell has not yet discovered a newly installed extension, log out and back in once before enabling it.

For development changes to `extension.js`, log out and back in before retesting to ensure GNOME Shell loads the updated module.

## Packaging for extensions.gnome.org

The extensions.gnome.org package contains only runtime files. From the extension directory:

```bash
zip -j gnome-honeycomb@adlair.zip extension.js metadata.json stylesheet.css LICENSE
```

## Troubleshooting

GNOME Honeycomb normally stays quiet in the journal. For development diagnostics, set `DEBUG = true` near the top of `extension.js`, then inspect:

```bash
journalctl --user -f | grep 'GNOME Honeycomb'
```

## License

GPL-2.0-or-later. See `LICENSE`.
