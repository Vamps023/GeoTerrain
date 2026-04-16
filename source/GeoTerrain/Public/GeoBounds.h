#pragma once

// Geographic bounding box in WGS84 decimal degrees.
/**
 * @brief Geographic bounding box in WGS84 decimal degrees.
 *
 * Represents a rectangular area defined by west, south, east, north coordinates.
 */
struct FGeoBounds
{
    double West  = 0.0;
    double South = 0.0;
    double East  = 0.0;
    double North = 0.0;

    double Width()  const { return East  - West;  }
    double Height() const { return North - South; }
    bool   IsValid() const { return East > West && North > South; }

    // Split into a grid of (cols x rows) sub-bounds
    FGeoBounds GetChunk(int Row, int Col, int Rows, int Cols) const
    {
        const double CellW = Width()  / Cols;
        const double CellH = Height() / Rows;
        FGeoBounds B;
        B.West  = West  + Col * CellW;
        B.East  = West  + (Col + 1) * CellW;
        B.South = South + Row * CellH;
        B.North = South + (Row + 1) * CellH;
        return B;
    }
};
