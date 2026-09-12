echo "Building C++ Call Graph extension..."
cd .\c_cpp_callgraph\
npm audit fix --force
npm install
npm run build
npm install -g @vscode/vsce
vsce package

echo "Building statemachine-visualizer extension..."
cd ..\statemachine-visualizer\
npm audit fix --force
npm install
npm run build
npm install -g @vscode/vsce
vsce package

echo "Building vistacode extension..."
cd ..\vistacode\
npm audit fix --force
npm install
npm run build
npm install -g @vscode/vsce
vsce package
