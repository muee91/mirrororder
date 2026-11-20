"""Candidate geometry only. Fixed studied form, no semantic column assignments."""
import math

def guard_manual_region(output, rectangle):
    """Reject the whole proposed grid before recognition if any cell leaves ROI."""
    if not isinstance(rectangle,list) or len(rectangle)!=4 or any(type(v) is not int for v in rectangle):raise ValueError('invalid_manual_rectangle')
    x0,y0,x1,y1=rectangle
    if not(x0<x1 and y0<y1):raise ValueError('invalid_manual_rectangle')
    cells=output.get('cells',[])
    if not isinstance(cells,list) or len(cells)>352:raise ValueError('invalid_grid_cells')
    unsafe=0
    for cell in cells:
        points=cell.get('pixel_polygon')
        if not isinstance(points,list) or len(points)!=4:raise ValueError('invalid_grid_polygon')
        outside=False
        for point in points:
            if not isinstance(point,list) or len(point)!=2 or any(type(v) not in (int,float) or not math.isfinite(v) for v in point):raise ValueError('invalid_grid_polygon')
            x,y=point
            outside |= not(x0<=x<=x1 and y0<=y<=y1)
        unsafe+=int(outside)
    if unsafe:
        return {'status':'ambiguous','reason':'grid_extrapolates_outside_manual_region','cells':[],
                'examined_cell_count':len(cells),'unsafe_cell_count':unsafe,
                'withheld_cell_count':len(cells)}
    return output

def cells_from_lines(grid,edge_support):
    vs,hs=grid.get('v',[]),grid.get('h',[])
    if not vs or not hs:return {'status':'no_grid','reason':'no_supported_rules','cells':[]}
    if len(vs)!=17 or len(hs)!=23:return {'status':'ambiguous','reason':'unsupported_grid_topology','cells':[]}
    x,y,w,h=grid['bbox'];xc=x+w/2;yc=y+h/2
    def values(lines):
        for line in lines:
            if any(type(line.get(k)) not in (int,float) or not math.isfinite(line[k]) for k in ('position','slope','coverage')):raise ValueError('nonfinite_grid')
            if abs(line['slope'])>.06 or not 0<=line['coverage']<=1:raise ValueError('invalid_grid_support')
        if any(a['position']>=b['position'] for a,b in zip(lines,lines[1:])):raise ValueError('unordered_rules')
    values(vs);values(hs)
    def cross(v,hline):
        # x=sv*(y-yc)+pv, y=sh*(x-xc)+ph
        sv,sh=v['slope'],hline['slope'];bv=v['position']-sv*yc;bh=hline['position']-sh*xc
        px=(sv*bh+bv)/(1-sv*sh);return [px,sh*px+bh]
    cells=[];ambiguous=False
    for row in range(22):
        for col in range(16):
            quad=[cross(vs[col],hs[row]),cross(vs[col+1],hs[row]),cross(vs[col+1],hs[row+1]),cross(vs[col],hs[row+1])]
            supports=[edge_support(quad[i],quad[(i+1)%4]) for i in range(4)]
            good=all(type(v) in (int,float) and math.isfinite(v) and .85<=v<=1 for v in supports)
            ambiguous |= not good
            cells.append({'row_index':row,'column_index':col,'pixel_polygon':quad,'edge_support':supports,
                          'state':'geometry_candidate' if good else 'ambiguous','reason':None if good else 'local_edge_missing'})
    return {'status':'ambiguous' if ambiguous else 'grid_candidates','reason':'some_edges_unproven' if ambiguous else None,'cells':cells}
